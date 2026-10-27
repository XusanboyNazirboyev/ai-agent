import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { AgentConversationService } from '../../agent-conversation.service.js';
import { LlmBudgetLedger } from '../../llm-budget-ledger.js';
import { LlmUsageStore } from '../../llm-usage.store.js';
import { ActionService } from '../../../actions/action.service.js';
import type { AppEnvironment } from '../../../config/environment.js';
import { TelegramAgentPipeline } from '../../../channels/telegram/telegram-agent-pipeline.js';
import { normalizeTelegramUpdate } from '../../../channels/telegram/telegram-normalizer.js';
import { TelegramProcessor } from '../../../channels/telegram/telegram-processor.js';
import type { TelegramSender } from '../../../channels/telegram/telegram-sender.js';
import { TelegramWebhookService } from '../../../channels/telegram/telegram-webhook.service.js';
import {
  markPublished,
  retireOutbox,
} from '../../../channels/telegram/testing/outbox.js';
import type { CrmConnector } from '../../../connectors/interfaces/crm-connector.js';
import { MockConnector } from '../../../connectors/mock/mock-connector.js';
import {
  allFixtures,
  type MockItemFixture,
} from '../../../connectors/mock/mock-fixtures.js';
import type { TenantConnectorLoader } from '../../../connectors/sync/tenant-connector-loader.js';
import { inQuietHours } from '../../../core/followup/policy.js';
import type { LlmProvider } from '../../../core/llm/llm-provider.js';
import { FollowUpService } from '../../../followup/follow-up.service.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { HandoverService } from '../../../handover/handover.service.js';
import type { PrismaService } from '../../../persistence/prisma.service.js';
import { EVAL_PACKS } from '../eval-runner.js';
import type { Scenario, SimLanguage } from './scenario.js';

/** Mock catalog per runnable pack (retail has no v1 pack yet: slice 3b). */
export const SOURCE: Record<'education' | 'travel', string> = {
  education: 'mock-education',
  travel: 'mock-tourism',
};
const TIME_ZONE = 'Asia/Tashkent';
const CONSENT = {
  'uz-Latn': 'Maʼlumotlaringiz kompaniyaga yuboriladi.',
  'uz-Cyrl': 'Маълумотларингиз компанияга юборилади.',
  ru: 'Ваши данные будут переданы компании.',
  en: 'Your details will be sent to the company.',
};

/** Agent settings of a simulation run: v1 defaults, pricing per provider. */
export function simulationSettings(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
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
    AGENT_TOOL_TIMEOUT_MS: 5_000,
    AGENT_HISTORY_MESSAGES: 8,
    AGENT_TURN_TIMEOUT_MS: 60_000,
    AGENT_TURN_LEASE_MS: 90_000,
    HANDOVER_SLA_MINUTES: 10,
    FOLLOWUP_ENABLED: true,
    ...overrides,
  };
}

/** Fictional CRM: catalog reads from the mock, lead writes always succeed. */
function crmFor(tenantId: string, source: string): CrmConnector {
  const reads = new MockConnector(
    { tenantId, connectorKey: 'mock' },
    { sourceSystem: source, items: allFixtures(source) },
  );
  const leads = new Map<string, string>();
  return {
    connectorKey: 'mock',
    context: reads.context,
    sourceSystem: reads.sourceSystem,
    capabilities: reads.capabilities,
    writeIdempotency: 'native',
    searchItems: (query) => reads.searchItems(query),
    getItem: (id) => reads.getItem(id),
    getOffers: (id) => reads.getOffers(id),
    checkAvailability: (id, request) => reads.checkAvailability(id, request),
    getQuote: (id, request) => reads.getQuote(id, request),
    createLead: (_input, context) => {
      const key = context?.idempotencyKey ?? randomUUID();
      const id = leads.get(key) ?? `sim-lead-${leads.size + 1}`;
      leads.set(key, id);
      return Promise.resolve({ crmLeadId: id });
    },
  } as CrmConnector;
}

/** A transcript line as stored, with the turn that produced a business reply. */
export interface WorldMessage {
  readonly direction: 'INBOUND' | 'OUTBOUND';
  readonly authorType: string;
  readonly text: string;
}

/** Everything the grader reads after a run (all tenant-scoped). */
export interface WorldState {
  readonly tenantId: string;
  readonly source: string;
  readonly messages: readonly WorldMessage[];
  readonly turns: readonly {
    outcome: string | null;
    locale: string | null;
    handoverReason: string | null;
    failureCode: string | null;
    latencyMs: number | null;
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    costNano: bigint;
  }[];
  readonly handoverReasons: readonly string[];
  /** Source entity ids of items whose offers were shown. */
  readonly shownItems: readonly string[];
  readonly slots: Record<string, unknown>;
  readonly leadCreated: boolean;
  readonly contactPhone: string | null;
  readonly proposals: readonly { status: string; externalId: string | null }[];
  readonly followUps: number;
  /** Times a `wait` was moved out of quiet hours (reported, not hidden). */
  readonly clockShifts: number;
}

/**
 * One fictional tenant with one Telegram test account and the real v1
 * pipeline (webhook -> processor -> agent -> commit). No queue, no Redis, no
 * network except the injected model provider.
 */
export class SimulationWorld {
  private readonly prisma: PrismaService;
  private updateCounter = 0;
  private clockOffsetMs = 0;
  private clockShifts = 0;
  private constructor(
    private readonly db: PrismaClient,
    readonly tenantId: string,
    private readonly accountId: string,
    private readonly chat: number,
    readonly source: string,
    private readonly webhook: TelegramWebhookService,
    private readonly processor: TelegramProcessor,
    private readonly followUps: FollowUpService,
    private readonly contactPreset: Scenario['setup']['contact'],
  ) {
    this.prisma = db as unknown as PrismaService;
  }

  static async create(options: {
    db: PrismaClient;
    scenario: Scenario;
    language: SimLanguage;
    provider: LlmProvider;
    settings: Record<string, unknown>;
  }): Promise<SimulationWorld> {
    const { db, scenario, language } = options;
    if (scenario.pack === 'retail')
      throw new Error('retail has no v1 pack (roadmap slice 3b)');
    const pack = EVAL_PACKS[scenario.pack];
    const source = SOURCE[scenario.pack];
    const spec = pack.actions[0];
    const prisma = db as unknown as PrismaService;
    const config = {
      get: (key: string) => options.settings[key],
    } as unknown as ConfigService<AppEnvironment, true>;
    const suffix = randomUUID();
    const tenant = await db.tenant.create({
      data: {
        slug: `sim-${scenario.id}-${language}-${suffix}`
          .slice(0, 60)
          .toLowerCase(),
        name: `Simulation ${scenario.id}`,
        defaultLocale: language,
        supportedLocales: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
        timezone: TIME_ZONE,
        packKey: pack.key,
        packVersion: pack.version,
        config: (scenario.setup.actionsEnabled && spec
          ? {
              actions: {
                [spec.key]: {
                  mode: 'live',
                  consent: CONSENT,
                  allowUnprotectedConnector: false,
                },
              },
            }
          : {}) as never,
      },
    });
    await db.tenantConnector.create({
      data: {
        tenantId: tenant.id,
        connectorKey: 'mock',
        status: 'ACTIVE',
        config: { sourceSystem: source },
      },
    });
    const account = await db.channelAccount.create({
      data: {
        tenantId: tenant.id,
        channelType: 'telegram',
        externalAccountId: `sim-${suffix}`,
        status: 'ACTIVE',
        agentMode: 'LIVE',
        isTestAccount: true,
      },
    });
    const crm = crmFor(tenant.id, source);
    const loader = { create: () => crm } as unknown as TenantConnectorLoader;
    const handovers = new HandoverService(prisma);
    const actions = new ActionService(prisma, loader, handovers, config);
    const agent = new AgentConversationService(
      prisma,
      loader,
      new LlmUsageStore(prisma),
      new LlmBudgetLedger(prisma),
      options.provider,
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
    const sender = {
      sendMessage: () => Promise.resolve({ messageId: '1' }),
    } as unknown as TelegramSender;
    const processor = new TelegramProcessor(
      prisma,
      sender,
      pipeline,
      undefined,
      undefined,
      undefined,
      undefined,
      actions,
    );
    const webhook = new TelegramWebhookService(prisma, {
      get: (key: string) =>
        ({
          TELEGRAM_CHANNEL_ACCOUNT_ID: account.id,
          TELEGRAM_WEBHOOK_SECRET: 's',
          TELEGRAM_RATE_LIMIT_PER_MINUTE: 10_000,
        })[key],
    } as never);
    return new SimulationWorld(
      db,
      tenant.id,
      account.id,
      80_000 + Math.floor(Math.random() * 1e6),
      source,
      webhook,
      processor,
      new FollowUpService(prisma, config),
      scenario.setup.contact,
    );
  }

  /** The customer sends one message; returns the business replies it caused. */
  async say(text: string): Promise<string[]> {
    const before = await this.outboundCount();
    this.updateCounter += 1;
    const updateId = this.updateCounter;
    const normalized = normalizeTelegramUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: Math.floor((Date.now() + this.clockOffsetMs) / 1000),
        chat: { id: this.chat },
        from: { id: this.chat, first_name: 'Sim' },
        text,
      },
    });
    if (normalized.kind !== 'text') throw new Error('text update expected');
    await this.webhook.accept(this.accountId, normalized);
    if (updateId === 1) await this.applyContactPreset();
    const outbox = await this.db.outboxEvent.findFirstOrThrow({
      where: {
        tenantId: this.tenantId,
        idempotencyKey: `telegram.inbound:${this.accountId}:${updateId}`,
      },
    });
    await this.processor.process({
      outboxId: outbox.id,
      tenantId: this.tenantId,
      type: outbox.type,
      payload: outbox.payload,
    });
    await markPublished(this.db, this.tenantId, outbox.id);
    // Confirmed actions run like the scheduled relay would run them.
    await this.deliver('action.execute');
    await this.deliver('telegram.send');
    return this.outboundSince(before);
  }

  /**
   * What the relay and worker do in production: pending events of this
   * tenant go through the real processor (`telegram.send` reaches the stub
   * sender, so delivery states become SENT as they would after Telegram).
   */
  private async deliver(
    type: 'action.execute' | 'telegram.send',
  ): Promise<void> {
    for (const event of await this.db.outboxEvent.findMany({
      where: { tenantId: this.tenantId, type, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    })) {
      await this.processor.process({
        outboxId: event.id,
        tenantId: this.tenantId,
        type: event.type,
        payload: event.payload as never,
      });
      await markPublished(this.db, this.tenantId, event.id);
    }
  }

  /** The customer goes silent; the follow-up scan runs at the shifted clock. */
  async wait(hours: number): Promise<string[]> {
    const before = await this.outboundCount();
    this.clockOffsetMs += hours * 3_600_000;
    const policy = this.followUps.policy();
    let now = new Date(Date.now() + this.clockOffsetMs);
    let shifted = false;
    for (let i = 0; i < 24 && inQuietHours(now, TIME_ZONE, policy); i += 1) {
      now = new Date(now.getTime() + 3_600_000);
      shifted = true;
    }
    if (shifted) this.clockShifts += 1;
    await this.followUps.scan(now, policy, { tenantId: this.tenantId });
    await this.deliver('telegram.send');
    return this.outboundSince(before);
  }

  async state(): Promise<WorldState> {
    const where = { tenantId: this.tenantId };
    const [
      messages,
      turns,
      handovers,
      shown,
      slotRows,
      leads,
      contact,
      proposals,
      followUps,
    ] = await Promise.all([
      this.db.message.findMany({ where, orderBy: { sequence: 'asc' } }),
      this.db.agentTurn.findMany({ where, orderBy: { createdAt: 'asc' } }),
      this.db.handover.findMany({ where }),
      this.db.shownOffer.findMany({ where }),
      this.db.conversationSlots.findMany({
        where,
        orderBy: { version: 'desc' },
        take: 1,
      }),
      this.db.lead.count({ where }),
      this.db.contact.findFirst({ where }),
      this.db.actionProposal.findMany({ where, orderBy: { createdAt: 'asc' } }),
      this.db.followUp.count({ where }),
    ]);
    const fixtures = allFixtures(this.source);
    // Facts the reply actually rendered: the turn's `shownFactIds` resolved
    // through its fact records to the catalog entity they came from.
    const shownEntities = turns.flatMap((turn) => {
      const shownIds = new Set((turn.shownFactIds as string[] | null) ?? []);
      const facts =
        (turn.facts as
          { id: string; provenance?: { sourceEntityId?: string } }[] | null) ??
        [];
      return facts
        .filter((fact) => shownIds.has(fact.id))
        .map((fact) => fact.provenance?.sourceEntityId ?? '')
        .filter(Boolean);
    });
    const stored =
      (slotRows[0]?.slots as
        { slots?: Record<string, { value?: unknown }> } | undefined) ?? {};
    const slots = Object.fromEntries(
      Object.entries(stored.slots ?? {}).map(([key, entry]) => [
        key,
        entry?.value,
      ]),
    );
    return {
      tenantId: this.tenantId,
      source: this.source,
      messages: messages.map((m) => ({
        direction: m.direction as 'INBOUND' | 'OUTBOUND',
        authorType: m.authorType,
        text: m.text ?? '',
      })),
      turns: turns.map((t) => ({
        outcome: t.outcome,
        locale: t.locale,
        handoverReason: t.handoverReason,
        failureCode: t.failureCode,
        latencyMs: t.latencyMs,
        llmCalls: t.llmCalls,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        costNano: t.actualCostNano,
      })),
      handoverReasons: handovers.map((h) => h.reasonCode),
      shownItems: [
        ...new Set(
          [...shown.map((s) => s.offerId ?? s.offerRef), ...shownEntities]
            .map((ref) => itemOfOffer(fixtures, ref))
            .filter((id): id is string => id !== undefined),
        ),
      ],
      slots,
      leadCreated: leads > 0,
      contactPhone: contact?.phone ?? null,
      proposals: proposals.map((p) => ({
        status: p.status,
        externalId: p.externalId,
      })),
      followUps,
      clockShifts: this.clockShifts,
    };
  }

  /** Leaves nothing for a relay in a shared database. */
  async close(): Promise<void> {
    await retireOutbox(this.db, [this.tenantId]);
  }

  private async applyContactPreset(): Promise<void> {
    const { name, phone } = this.contactPreset;
    if (!name && !phone) return;
    const contact = await this.db.contact.findFirst({
      where: { tenantId: this.tenantId },
    });
    if (contact)
      await this.db.contact.update({
        where: { id: contact.id },
        data: { ...(name ? { name } : {}), ...(phone ? { phone } : {}) },
      });
  }

  private outboundCount(): Promise<number> {
    return this.db.message.count({
      where: { tenantId: this.tenantId, direction: 'OUTBOUND' },
    });
  }

  private async outboundSince(count: number): Promise<string[]> {
    const rows = await this.db.message.findMany({
      where: { tenantId: this.tenantId, direction: 'OUTBOUND' },
      orderBy: { sequence: 'asc' },
      skip: count,
    });
    return rows.map((row) => row.text ?? '');
  }
}

function itemOfOffer(
  fixtures: readonly MockItemFixture[],
  offerRef: string,
): string | undefined {
  for (const item of fixtures) {
    if (offerRef.includes(item.sourceEntityId)) return item.sourceEntityId;
    if (item.offers.some((offer) => offerRef.includes(offer.sourceEntityId)))
      return item.sourceEntityId;
  }
  return undefined;
}
