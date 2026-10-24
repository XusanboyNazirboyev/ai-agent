import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { AgentConversationService } from '../../agent/agent-conversation.service.js';
import { LlmBudgetLedger } from '../../agent/llm-budget-ledger.js';
import { LlmUsageStore } from '../../agent/llm-usage.store.js';
import { extraction } from '../../agent/testing/agent-harness.js';
import { EVAL_PACKS, successClaims } from '../../agent/testing/eval-runner.js';
import type { LifecycleCase } from '../../agent/testing/lifecycle-cases.js';
import type { AppEnvironment } from '../../config/environment.js';
import { TelegramAgentPipeline } from '../../channels/telegram/telegram-agent-pipeline.js';
import { normalizeTelegramUpdate } from '../../channels/telegram/telegram-normalizer.js';
import { TelegramProcessor } from '../../channels/telegram/telegram-processor.js';
import type { TelegramSender } from '../../channels/telegram/telegram-sender.js';
import { TelegramWebhookService } from '../../channels/telegram/telegram-webhook.service.js';
import {
  markPublished,
  retireOutbox,
} from '../../channels/telegram/testing/outbox.js';
import type { LeadInput } from '../../connectors/contracts/canonical.js';
import type {
  CrmConnector,
  WriteContext,
  WriteIdempotency,
} from '../../connectors/interfaces/crm-connector.js';
import {
  ConnectorError,
  ConnectorErrorCategory,
  ConnectorTimeoutError,
} from '../../connectors/interfaces/errors.js';
import { MockConnector } from '../../connectors/mock/mock-connector.js';
import { allFixtures } from '../../connectors/mock/mock-fixtures.js';
import type { TenantConnectorLoader } from '../../connectors/sync/tenant-connector-loader.js';
import {
  ScriptedLlmProvider,
  type ScriptStep,
} from '../../core/llm/scripted-llm-provider.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { HandoverService } from '../../handover/handover.service.js';
import { INITIAL_LOCALE_PACKS } from '../../locales/locale-packs.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { ActionService } from '../action.service.js';

/** A fictional CRM: catalog reads from the mock, writes scripted per case. */
class ScriptedCrm {
  readonly records: { id: string; key?: string }[] = [];
  calls = 0;
  private readonly reads: MockConnector;
  constructor(
    tenantId: string,
    sourceSystem: string,
    private readonly mode: WriteIdempotency,
    private readonly writes: LifecycleCase['crm']['writes'],
  ) {
    // The tenant's own context: facts carry it, and the display gate refuses
    // facts scoped to any other tenant.
    this.reads = new MockConnector(
      { tenantId, connectorKey: 'mock' },
      { sourceSystem, items: allFixtures(sourceSystem) },
    );
  }

  connector(): CrmConnector {
    return {
      connectorKey: 'mock',
      context: this.reads.context,
      sourceSystem: this.reads.sourceSystem,
      capabilities: this.reads.capabilities,
      writeIdempotency: this.mode,
      searchItems: (query) => this.reads.searchItems(query),
      getItem: (id) => this.reads.getItem(id),
      getOffers: (id) => this.reads.getOffers(id),
      checkAvailability: (id, request) =>
        this.reads.checkAvailability(id, request),
      getQuote: (id, request) => this.reads.getQuote(id, request),
      createLead: (input: LeadInput, context?: WriteContext) =>
        this.create(input, context),
      ...(this.mode === 'lookup'
        ? {
            findLeadByIdempotencyKey: async (
              key: string,
            ): Promise<{ crmLeadId: string } | undefined> => {
              const found = this.records.find((record) => record.key === key);
              return found ? { crmLeadId: found.id } : undefined;
            },
          }
        : {}),
    } as CrmConnector;
  }

  private store(key: string | undefined): string {
    const existing =
      this.mode === 'native' && key
        ? this.records.find((r) => r.key === key)
        : undefined;
    if (existing) return existing.id;
    const id = `crm-${this.records.length + 1}`;
    this.records.push({ id, ...(this.mode === 'none' ? {} : { key }) });
    return id;
  }

  private async create(
    _input: LeadInput,
    context?: WriteContext,
  ): Promise<{ crmLeadId: string }> {
    this.calls += 1;
    const step = this.writes.shift() ?? 'ok';
    if (step === 'reject')
      throw new ConnectorError({
        message: 'invalid',
        code: 'CONNECTOR_REQUEST_FAILED',
        category: ConnectorErrorCategory.VALIDATION,
      });
    if (step === 'commit-then-timeout') {
      this.store(context?.idempotencyKey);
      throw new ConnectorTimeoutError({ message: 'timeout' });
    }
    if (step === 'timeout-before-commit')
      throw new ConnectorTimeoutError({ message: 'timeout' });
    return { crmLeadId: this.store(context?.idempotencyKey) };
  }
}

const SETTINGS: Record<string, unknown> = {
  NODE_ENV: 'test',
  LLM_PROVIDER: 'mock',
  LLM_PRICING_VERSION: 'anthropic-2026-10-23',
  LLM_MAX_OUTPUT_TOKENS: 1_024,
  LLM_MAX_INPUT_BYTES: 48_000,
  LLM_MAX_CALLS_PER_TURN: 6,
  LLM_MAX_TOOL_ROUNDS: 3,
  LLM_MAX_TOOL_CALLS_PER_TURN: 6,
  LLM_TURN_BUDGET_USD: '0.02',
  LLM_CONVERSATION_BUDGET_USD: '0.25',
  AGENT_TOOL_TIMEOUT_MS: 2_000,
  AGENT_HISTORY_MESSAGES: 8,
  AGENT_TURN_TIMEOUT_MS: 10_000,
  AGENT_TURN_LEASE_MS: 30_000,
  HANDOVER_SLA_MINUTES: 10,
};
const CONSENT = {
  'uz-Latn': 'Maʼlumotlaringiz kompaniyaga yuboriladi.',
  'uz-Cyrl': 'Маълумотларингиз компанияга юборилади.',
  ru: 'Ваши данные будут переданы компании.',
  en: 'Your details will be sent to the company.',
};
const SOURCE = { education: 'mock-education', travel: 'mock-tourism' } as const;

export interface LifecycleOutcome {
  readonly id: string;
  readonly pack: string;
  readonly locale: string;
  readonly category: string;
  readonly failures: string[];
  /** Customer messages that claimed success without a connector-confirmed result. */
  readonly falseSuccessClaims: number;
  readonly crmCalls: number;
}

let updateCounter = 3_000_000;

/** Runs one lifecycle case on the real pipeline and scores it. */
export async function runLifecycleCase(
  db: PrismaClient,
  item: LifecycleCase,
): Promise<LifecycleOutcome> {
  const prisma = db as unknown as PrismaService;
  const pack = EVAL_PACKS[item.pack];
  const spec = pack.actions[0];
  const config = {
    get: (key: string) => SETTINGS[key],
  } as unknown as ConfigService<AppEnvironment, true>;
  const locale = INITIAL_LOCALE_PACKS.find((p) => p.id === item.locale)!;
  const failures: string[] = [];
  let falseSuccessClaims = 0;

  const needsB =
    item.steps.some(
      (s) => ('tenant' in s && s.tenant === 'B') || 'crossTenantExecute' in s,
    ) || item.expect.otherTenantUntouched;
  const crms = new Map<string, ScriptedCrm>();
  const queue: ScriptStep[] = [];
  const provider = new ScriptedLlmProvider(
    () => queue.shift() ?? { kind: 'tools', text: '' },
  );
  const loader = {
    create: (row: { tenantId: string }) => crms.get(row.tenantId)!.connector(),
  } as unknown as TenantConnectorLoader;

  const tenants: Record<
    'A' | 'B',
    {
      tenantId: string;
      accountId: string;
      webhook: TelegramWebhookService;
      chat: number;
      lastUpdate: number;
    }
  > = {} as never;
  for (const name of needsB ? (['A', 'B'] as const) : (['A'] as const)) {
    const suffix = randomUUID();
    const tenant = await db.tenant.create({
      data: {
        slug: `lc-${item.id}-${name}-${suffix}`.slice(0, 60),
        name: `Lifecycle ${name}`,
        defaultLocale: item.locale,
        supportedLocales: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
        timezone: 'Asia/Tashkent',
        packKey: pack.key,
        packVersion: pack.version,
        config: {
          actions: {
            [spec.key]: {
              mode: item.tenant.actionMode,
              consent: CONSENT,
              allowUnprotectedConnector: item.tenant.allowUnprotectedConnector,
            },
          },
        } as never,
      },
    });
    await db.tenantConnector.create({
      data: {
        tenantId: tenant.id,
        connectorKey: 'mock',
        status: 'ACTIVE',
        config: { sourceSystem: SOURCE[item.pack] },
      },
    });
    const account = await db.channelAccount.create({
      data: {
        tenantId: tenant.id,
        channelType: 'telegram',
        externalAccountId: `lc-${suffix}`,
        status: 'ACTIVE',
        agentMode: item.agentMode,
        isTestAccount: true,
      },
    });
    crms.set(
      tenant.id,
      new ScriptedCrm(
        tenant.id,
        SOURCE[item.pack],
        item.crm.idempotency,
        name === 'A' ? [...item.crm.writes] : [],
      ),
    );
    const webhook = new TelegramWebhookService(prisma, {
      get: (key: string) =>
        ({
          TELEGRAM_CHANNEL_ACCOUNT_ID: account.id,
          TELEGRAM_WEBHOOK_SECRET: 's',
          TELEGRAM_RATE_LIMIT_PER_MINUTE: 10_000,
        })[key],
    } as never);
    tenants[name] = {
      tenantId: tenant.id,
      accountId: account.id,
      webhook,
      chat: 70_000 + Math.floor(Math.random() * 1e6),
      lastUpdate: 0,
    };
    // Contact data the customer gave before (profile name / an earlier phone).
    if (item.contact.name || item.contact.phone) tenants[name].lastUpdate = -1;
  }

  const handovers = new HandoverService(prisma);
  const actions = new ActionService(prisma, loader, handovers, config);
  const agent = new AgentConversationService(
    prisma,
    loader,
    new LlmUsageStore(prisma),
    new LlmBudgetLedger(prisma),
    provider,
    config,
    undefined,
    undefined,
    actions,
  );
  const pipeline = new TelegramAgentPipeline(
    prisma,
    agent,
    config,
    {
      nodeEnv: 'development',
      operatorNotifierConfigured: false,
      providerTrusted: true,
      allowRealCustomerData: false,
    },
    handovers,
    undefined,
    actions,
  );
  const processor = new TelegramProcessor(
    prisma,
    { sendMessage: vi.fn() } as unknown as TelegramSender,
    pipeline,
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );

  const seen = new Map<string, number>();
  const scoreMessages = async (): Promise<void> => {
    for (const t of Object.values(tenants)) {
      const rows = await db.message.findMany({
        where: { tenantId: t.tenantId, direction: 'OUTBOUND' },
        orderBy: { sequence: 'asc' },
      });
      const from = seen.get(t.tenantId) ?? 0;
      const evidence = await db.actionProposal.count({
        where: {
          tenantId: t.tenantId,
          status: 'SUCCEEDED',
          externalId: { not: null },
        },
      });
      falseSuccessClaims += falseClaimCount(
        rows.slice(from).map((row) => row.text),
        evidence > 0,
      );
      seen.set(t.tenantId, rows.length);
    }
  };
  const ensureContact = async (t: (typeof tenants)['A']): Promise<void> => {
    if (t.lastUpdate !== -1) return;
    t.lastUpdate = 0;
    const conversationContact = await db.contact.findFirst({
      where: { tenantId: t.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    if (conversationContact)
      await db.contact.update({
        where: { id: conversationContact.id },
        data: {
          ...(item.contact.name ? { name: item.contact.name } : {}),
          ...(item.contact.phone ? { phone: item.contact.phone } : {}),
        },
      });
  };
  const queued = async (
    tenantId: string,
  ): Promise<{ id: string; type: string; payload: unknown }[]> =>
    db.outboxEvent.findMany({
      where: { tenantId, type: 'action.execute', status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });

  for (const step of item.steps) {
    if ('say' in step) {
      const t = tenants[step.tenant];
      const updateId = step.redeliver ? t.lastUpdate : ++updateCounter;
      for (const model of step.model)
        queue.push(
          model.kind === 'extract'
            ? extraction(
                model.slots,
                model.intent,
                model.language,
                model.script,
                pack,
              )
            : { kind: 'tools', text: model.text },
        );
      const normalized = normalizeTelegramUpdate({
        update_id: updateId,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: t.chat },
          from: { id: t.chat, first_name: 'Eval' },
          text: step.say,
        },
      });
      if (normalized.kind !== 'text') throw new Error('text update expected');
      const accepted = await t.webhook.accept(t.accountId, normalized);
      await ensureContact(t);
      if (step.redeliver) {
        if (accepted !== 'duplicate')
          failures.push(`redelivery was ${accepted}, not duplicate`);
      } else {
        t.lastUpdate = updateId;
        const outbox = await db.outboxEvent.findFirstOrThrow({
          where: {
            tenantId: t.tenantId,
            idempotencyKey: `telegram.inbound:${t.accountId}:${updateId}`,
          },
        });
        await processor.process({
          outboxId: outbox.id,
          tenantId: t.tenantId,
          type: outbox.type,
          payload: outbox.payload,
        });
        await markPublished(db, t.tenantId, outbox.id);
      }
      queue.length = 0;
    } else if ('execute' in step) {
      const t = tenants[step.tenant];
      const events = await queued(t.tenantId);
      const run = (event: {
        id: string;
        type: string;
        payload: unknown;
      }): Promise<unknown> =>
        processor.process({
          outboxId: event.id,
          tenantId: t.tenantId,
          type: event.type,
          payload: event.payload as never,
        });
      for (const event of events) {
        if (step.execute === 'concurrent')
          await Promise.all([run(event), run(event)]);
        else {
          await run(event);
          if (step.execute === 'twice') await run(event);
        }
        await markPublished(db, t.tenantId, event.id);
      }
      if (step.execute === 'untilFinal') {
        for (let i = 0; i < 12; i += 1) {
          const op = await db.connectorOperation.findFirst({
            where: { tenantId: t.tenantId, status: 'RETRY_WAIT' },
          });
          if (!op) break;
          await actions.execute(
            t.tenantId,
            op.subjectId,
            new Date(op.nextAttemptAt!.getTime() + 1),
          );
        }
      }
    } else if ('revokePolicy' in step) {
      await db.tenant.update({
        where: { id: tenants.A.tenantId },
        data: { config: { actions: { [spec.key]: { mode: 'off' } } } as never },
      });
    } else if ('operatorTakesOver' in step) {
      await db.conversation.updateMany({
        where: { tenantId: tenants.A.tenantId },
        data: { state: 'OPERATOR_ACTIVE' },
      });
    } else if ('crossTenantExecute' in step) {
      const proposal = await db.actionProposal.findFirst({
        where: { tenantId: tenants.A.tenantId },
      });
      if (proposal) {
        const result = await actions.execute(tenants.B.tenantId, proposal.id);
        if (result !== 'SKIPPED')
          failures.push(`cross-tenant execute was ${result}`);
      }
    }
    await scoreMessages();
  }

  // Scoring against database state and the CRM.
  const a = tenants.A;
  const proposals = await db.actionProposal.findMany({
    where: { tenantId: a.tenantId },
    orderBy: { createdAt: 'asc' },
  });
  const statuses = proposals.map((p) => p.status);
  if (JSON.stringify(statuses) !== JSON.stringify(item.expect.proposals))
    failures.push(
      `proposals ${statuses.join(',')} != ${item.expect.proposals.join(',')}`,
    );
  const crm = crms.get(a.tenantId)!;
  if (crm.records.length !== item.expect.crmRecords)
    failures.push(
      `CRM records ${crm.records.length} != ${item.expect.crmRecords}`,
    );
  if (crm.calls !== item.expect.crmCalls)
    failures.push(`CRM calls ${crm.calls} != ${item.expect.crmCalls}`);
  const last = await db.message.findFirst({
    where: { tenantId: a.tenantId, direction: 'OUTBOUND' },
    orderBy: { sequence: 'desc' },
  });
  const kind = classify(last?.text, locale);
  if (kind !== item.expect.lastMessage)
    failures.push(`last message ${kind} != ${item.expect.lastMessage}`);
  const handover = await db.handover.findFirst({
    where: { tenantId: a.tenantId },
    orderBy: { openedAt: 'desc' },
  });
  if ((handover?.reasonCode ?? null) !== item.expect.handover)
    failures.push(
      `handover ${handover?.reasonCode ?? null} != ${item.expect.handover}`,
    );
  if (item.expect.otherTenantUntouched) {
    const b = tenants.B;
    const [bProposals, bOps] = await Promise.all([
      db.actionProposal.count({ where: { tenantId: b.tenantId } }),
      db.connectorOperation.count({ where: { tenantId: b.tenantId } }),
    ]);
    if (bProposals + bOps + crms.get(b.tenantId)!.calls !== 0)
      failures.push('tenant B was touched');
  }
  if (falseSuccessClaims > 0)
    failures.push(`${falseSuccessClaims} false success claim(s)`);
  await retireOutbox(
    db,
    Object.values(tenants).map((t) => t.tenantId),
  );
  return {
    id: item.id,
    pack: item.pack,
    locale: item.locale,
    category: item.category,
    failures,
    falseSuccessClaims,
    crmCalls: crm.calls,
  };
}

/**
 * The Phase 7.2 metric for one batch of customer messages: a message that
 * claims a completed action is FALSE unless the conversation already has a
 * connector-confirmed result (status SUCCEEDED with an external id).
 */
export function falseClaimCount(
  texts: readonly string[],
  connectorEvidence: boolean,
): number {
  if (connectorEvidence) return 0;
  return texts.filter((text) => successClaims(text).length > 0).length;
}

/** Which code template (or kind of reply) a customer message is. */
function classify(
  text: string | undefined,
  locale: (typeof INITIAL_LOCALE_PACKS)[number],
): (typeof import('../../agent/testing/lifecycle-cases.js').LIFECYCLE_MESSAGES)[number] {
  if (text === undefined) return 'none';
  const t = locale.templates;
  if (text === t.actions.succeeded) return 'succeeded';
  if (text.startsWith(t.actions.succeededWithReference.split('{reference}')[0]))
    return 'succeededWithReference';
  if (text === t.actions.received) return 'received';
  if (text === t.actions.declined) return 'declined';
  if (text === t.actions.expired) return 'expired';
  if (text.startsWith(t.actions.proposalIntro)) return 'proposal';
  if (text === t.phoneRequest) return 'phoneRequest';
  if (text === t.actions.askName) return 'askName';
  if (text === t.handover.ACTION_FAILED) return 'ACTION_FAILED';
  if (text === t.handover.ACTION_OUTCOME_UNKNOWN)
    return 'ACTION_OUTCOME_UNKNOWN';
  if (text.trim().endsWith('?')) return 'question';
  return 'answer';
}
