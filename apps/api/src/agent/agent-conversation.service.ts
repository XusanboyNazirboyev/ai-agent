import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConversationSlotsSchema,
  type DomainPack,
  type TenantConnectorKey,
} from '@agentcore/shared';
import type { AppEnvironment } from '../config/environment.js';
import type { CrmConnector } from '../connectors/interfaces/crm-connector.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import {
  interruptedTurnResult,
  runAgentTurn,
  type AgentTurnInput,
  type AgentTurnResult,
} from '../core/agent/agent-turn.js';
import { PROMPT_VERSION, type HistoryEntry } from '../core/agent/prompts.js';
import type { SlotState } from '../core/agent/slots.js';
import { TurnBudget } from '../core/llm/budget.js';
import type { LlmProvider } from '../core/llm/llm-provider.js';
import { MeteredLlm, type LlmUsageEntry } from '../core/llm/metered-llm.js';
import { pricingAgeDays, type PricingSnapshot } from '../core/llm/pricing.js';
import { LocaleRegistry, type LocaleId } from '../core/locales/locale-pack.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  PRICING_CATALOG,
  PRICING_MAX_AGE_DAYS,
} from '../llm/pricing-catalog.js';
import { INITIAL_LOCALE_PACKS } from '../locales/locale-packs.js';
import { EDUCATION_PACK } from '../packs/education/education.pack.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { budgetLimits, llmEnvironment } from './llm.factory.js';
import type { BudgetLedger } from '../core/llm/budget-ledger.js';
import type { EmbeddingProvider } from '../core/knowledge/embedding.js';
import { EMBEDDING_PROVIDER } from '../knowledge/embedding.factory.js';
import { KnowledgeRetriever } from '../knowledge/knowledge-retriever.js';
import type { KnowledgeService } from '../knowledge/knowledge.service.js';
import { LlmBudgetLedger } from './llm-budget-ledger.js';
import { LlmUsageStore } from './llm-usage.store.js';

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/** Registered Domain Packs by `key@version` (tenants select one). */
export const DOMAIN_PACKS: ReadonlyMap<string, DomainPack> = new Map([
  [`${EDUCATION_PACK.key}@${EDUCATION_PACK.version}`, EDUCATION_PACK],
]);

export class AgentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigurationError';
  }
}

export interface TurnRequest {
  readonly tenantId: string;
  readonly conversationId: string;
  /** Metering key: usage records of this attempt carry it as turnKey. */
  readonly turnKey: string;
  /** The customer text being answered (one or more merged messages). */
  readonly text: string;
  /**
   * History is read from messages strictly below this sequence, so the
   * answered messages are not repeated as history. Omit to use all.
   */
  readonly beforeSequence?: number;
}

/** Everything a commit needs; computing it has no side effects but usage. */
export interface ComputedTurn {
  readonly result: AgentTurnResult;
  readonly slotsBefore: SlotState;
  readonly usage: readonly LlmUsageEntry[];
  readonly latencyMs: number;
  readonly providerId: string;
  readonly pricingVersion: string;
  readonly promptVersion: string;
  readonly packRef: string;
  /** The turn deadline fired; the result is a LLM_UNAVAILABLE handover. */
  readonly timedOut: boolean;
}

type TransactionClient = Prisma.TransactionClient;

/**
 * Loads tenant-scoped context with short reads and runs one agent turn
 * without holding a transaction, a row lock or a pooled connection while
 * the model and tools work. Its only writes are LLM usage records (one per
 * billed provider response). Slots, language, messages and handovers are
 * written by the caller's commit step via `applyTurnState`.
 */
@Injectable()
export class AgentConversationService implements OnModuleInit {
  private readonly logger = new Logger(AgentConversationService.name);
  private readonly locales = new LocaleRegistry(INITIAL_LOCALE_PACKS);
  private readonly pricing: PricingSnapshot;

  constructor(
    private readonly prisma: PrismaService,
    private readonly loader: TenantConnectorLoader,
    private readonly usage: LlmUsageStore,
    private readonly ledger: LlmBudgetLedger,
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    private readonly config: ConfigService<AppEnvironment, true>,
    @Optional() private readonly knowledgeStore?: KnowledgeService,
    @Optional()
    @Inject(EMBEDDING_PROVIDER)
    private readonly embedder?: EmbeddingProvider,
  ) {
    this.pricing = PRICING_CATALOG.snapshot(
      this.config.get('LLM_PRICING_VERSION', { infer: true }),
    );
  }

  onModuleInit(): void {
    const age = pricingAgeDays(this.pricing, new Date());
    if (age > PRICING_MAX_AGE_DAYS) {
      this.logger.warn(
        JSON.stringify({
          event: 'llm.pricing_stale',
          pricingVersion: this.pricing.version,
          asOf: this.pricing.asOf,
          ageDays: age,
          source: this.pricing.source,
        }),
      );
    }
  }

  get localeRegistry(): LocaleRegistry {
    return this.locales;
  }

  /** Runs one turn. Throws AgentConfigurationError for unusable tenants. */
  async compute(request: TurnRequest): Promise<ComputedTurn> {
    const started = Date.now();
    const { tenantId, conversationId } = request;
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });
    if (!tenant) throw new AgentConfigurationError('Unknown tenant');
    const packRef = `${tenant.packKey}@${tenant.packVersion}`;
    const pack = DOMAIN_PACKS.get(packRef);
    if (!pack)
      throw new AgentConfigurationError(
        `Domain pack ${packRef} is not registered`,
      );
    const conversation = await this.prisma.conversation.findFirst({
      where: { tenantId, id: conversationId },
    });
    if (!conversation)
      throw new AgentConfigurationError('Unknown conversation');

    const supported = tenant.supportedLocales.filter(
      (id): id is LocaleId => this.locales.has(id) && pack.locales.includes(id),
    );
    if (supported.length === 0)
      throw new AgentConfigurationError('Tenant has no supported agent locale');
    const defaultLocale = supported.includes(tenant.defaultLocale as LocaleId)
      ? (tenant.defaultLocale as LocaleId)
      : supported[0];
    const current =
      conversation.language && conversation.script
        ? this.locales.find(
            conversation.language as 'uz',
            conversation.script as 'Latn',
          )?.id
        : undefined;

    const [
      slotRow,
      recent,
      connector,
      conversationSpent,
      monthSpent,
      conversationTokens,
      conversationExposure,
      monthExposure,
    ] = await Promise.all([
      this.prisma.conversationSlots.findFirst({
        where: { tenantId, conversationId },
        orderBy: { version: 'desc' },
      }),
      this.prisma.message.findMany({
        where: {
          tenantId,
          conversationId,
          ...(request.beforeSequence !== undefined
            ? { sequence: { lt: request.beforeSequence } }
            : {}),
        },
        orderBy: { sequence: 'desc' },
        take: this.config.get('AGENT_HISTORY_MESSAGES', { infer: true }),
        select: { direction: true, text: true },
      }),
      this.connectorFor(tenantId),
      this.usage.conversationSpendNano(tenantId, conversationId),
      this.usage.tenantMonthSpendNano(tenantId),
      this.usage.conversationTokens(tenantId, conversationId),
      this.ledger.conversationExposure(tenantId, conversationId),
      this.ledger.tenantMonthExposureNano(tenantId),
    ]);
    const slots = slotState(slotRow?.slots);
    const history: HistoryEntry[] = recent.reverse().map((message) => ({
      role: message.direction === 'INBOUND' ? 'customer' : 'agent',
      text: message.text,
    }));

    const environment = llmEnvironment(this.config);
    const budget = new TurnBudget(budgetLimits(environment), {
      conversationSpentNano: conversationSpent,
      tenantMonthSpentNano: monthSpent,
      conversationTokensUsed: conversationTokens,
      conversationExposureNano: conversationExposure.nano,
      conversationExposureTokens: conversationExposure.tokens,
      tenantMonthExposureNano: monthExposure,
    });
    const deadline = new AbortController();
    const entries: LlmUsageEntry[] = [];
    // The turn keeps every usage entry, persisted or not.
    const ledger: BudgetLedger = {
      reserve: (request) => this.ledger.reserve(request),
      settle: (tenant, id, entry) => {
        entries.push(entry);
        return this.ledger.settle(tenant, id, entry);
      },
      markUnknown: (tenant, id, entry) => {
        entries.push(entry);
        return this.ledger.markUnknown(tenant, id, entry);
      },
      release: (tenant, id) => this.ledger.release(tenant, id),
    };
    const llm = new MeteredLlm(
      this.provider,
      this.pricing,
      budget,
      {
        record: async (entry): Promise<boolean> => {
          entries.push(entry);
          return this.usage.record(entry);
        },
      },
      {
        tenantId,
        conversationId,
        turnKey: request.turnKey,
        signal: deadline.signal,
      },
      (error) =>
        this.logger.error(
          JSON.stringify({
            event: 'agent.usage_record_failed',
            tenant: tenantId,
            name: (error as Error).name,
          }),
        ),
      ledger,
    );

    // Progress and contact signals for the STUCK trigger and the one-time
    // phone request: stored per-turn signals, never raw customer text.
    const stuckLimit =
      this.config.get('STUCK_REPEAT_LIMIT', { infer: true }) ?? 2;
    const [priorTurns, contactRow, phoneAsked] = await Promise.all([
      this.prisma.agentTurn.findMany({
        where: { tenantId, conversationId, status: 'COMMITTED' },
        orderBy: { completedAt: 'desc' },
        take: stuckLimit,
        select: {
          outcome: true,
          askedSlot: true,
          slotsFilled: true,
          textFingerprint: true,
        },
      }),
      this.prisma.contact.findFirst({
        where: { tenantId, id: conversation.contactId },
        select: { phone: true },
      }),
      this.prisma.message.findFirst({
        where: {
          tenantId,
          conversationId,
          direction: 'OUTBOUND',
          OR: INITIAL_LOCALE_PACKS.map((pack) => ({
            text: { contains: pack.templates.phoneRequest },
          })),
        },
        select: { id: true },
      }),
    ]);

    // Retrieval sends the customer's question to the embedding provider, so
    // it follows the chat data-protection rule: a trusted provider, a test
    // account, or the owner's explicit consent.
    const account = await this.prisma.channelAccount.findFirst({
      where: { tenantId, id: conversation.channelAccountId },
      select: { isTestAccount: true },
    });
    const knowledgeAllowed =
      this.embedder !== undefined &&
      this.knowledgeStore !== undefined &&
      ((environment.LLM_TRUSTED_PROVIDERS ?? []).includes(
        this.embedder.providerId,
      ) ||
        account?.isTestAccount === true ||
        environment.LLM_ALLOW_REAL_CUSTOMER_DATA === true);
    const knowledge =
      knowledgeAllowed && this.embedder && this.knowledgeStore
        ? new KnowledgeRetriever(
            this.knowledgeStore,
            this.embedder,
            llm,
            tenantId,
          )
        : undefined;

    const maxOutput = environment.LLM_MAX_OUTPUT_TOKENS;
    const input: AgentTurnInput = {
      progress: {
        priorTurns: priorTurns
          .reverse()
          .map((turn) => ({ ...turn, outcome: turn.outcome ?? 'UNKNOWN' })),
        stuck: { repeatLimit: stuckLimit },
      },
      contact: {
        hasPhone: Boolean(contactRow?.phone),
        phoneRequested: Boolean(phoneAsked),
      },
      turnKey: request.turnKey,
      customerText: request.text,
      history,
      slots,
      conversationLocale: current,
      supportedLocales: supported,
      defaultLocale,
      timeZone: tenant.timezone,
    };
    const timeoutMs = this.config.get('AGENT_TURN_TIMEOUT_MS', { infer: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([
      runAgentTurn(input, {
        pack,
        locales: this.locales,
        connector,
        llm,
        scope: { tenantId, conversationId },
        ...(knowledge ? { knowledge } : {}),
        toolTimeoutMs: this.config.get('AGENT_TOOL_TIMEOUT_MS', {
          infer: true,
        }),
        maxOutputTokens: {
          extract: Math.min(600, maxOutput),
          respond: maxOutput,
        },
      }),
      timedOut,
    ]).finally(() => clearTimeout(timer));
    let result: AgentTurnResult;
    if (outcome === 'timeout') {
      // Abort in-flight provider calls; late tool or model results are
      // discarded. Usage already billed stays recorded.
      deadline.abort();
      result = interruptedTurnResult(
        input,
        this.locales,
        budget.snapshot,
        'LLM_UNAVAILABLE',
        'TURN_TIMEOUT',
      );
    } else {
      result = outcome;
    }

    this.logger.log(
      JSON.stringify({
        event: 'agent.turn_computed',
        tenant: tenantId,
        conversation: conversationId,
        turn: request.turnKey,
        outcome: result.outcome,
        locale: result.locale,
        handover: result.handover,
        intent: result.intent,
        costNano: result.budget.spentNano,
        calls: result.budget.calls,
        toolCalls: result.budget.toolCalls,
        budgetStop: result.budgetStop,
        violations: result.violations,
        safety: result.safety
          ? {
              status: result.safety.status,
              gate: result.safety.gate,
              reasonCodes: result.safety.reasonCodes,
            }
          : undefined,
        unknownExposureNano: result.budget.unknownExposureNano,
        overshootNano: result.budget.overshootNano,
        timedOut: outcome === 'timeout',
      }),
    );
    return {
      result,
      slotsBefore: slots,
      usage: entries,
      latencyMs: Date.now() - started,
      providerId: this.provider.providerId,
      pricingVersion: this.pricing.version,
      promptVersion: PROMPT_VERSION,
      packRef,
      timedOut: outcome === 'timeout',
    };
  }

  /**
   * Persists the turn's slots (new version only when they changed) and the
   * conversation's language/script. Called inside the commit transaction.
   */
  async applyTurnState(
    tx: TransactionClient,
    tenantId: string,
    conversationId: string,
    computed: ComputedTurn,
  ): Promise<void> {
    const { result } = computed;
    const locale = this.locales.get(result.locale);
    if (JSON.stringify(computed.slotsBefore) !== JSON.stringify(result.slots)) {
      const latest = await tx.conversationSlots.findFirst({
        where: { tenantId, conversationId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const next = (latest?.version ?? 0) + 1;
      await tx.conversationSlots.create({
        data: {
          tenantId,
          conversationId,
          version: next,
          slots: ConversationSlotsSchema.parse({
            version: next,
            slots: result.slots,
          }),
        },
      });
    }
    await tx.conversation.updateMany({
      where: { tenantId, id: conversationId },
      data: { language: locale.language, script: locale.script },
    });
  }

  /** Compute and persist in one call (tests and non-channel callers). */
  async handleCustomerMessage(request: TurnRequest): Promise<AgentTurnResult> {
    const computed = await this.compute(request);
    await this.prisma.$transaction((tx) =>
      this.applyTurnState(
        tx,
        request.tenantId,
        request.conversationId,
        computed,
      ),
    );
    return computed.result;
  }

  /** First active connector of the tenant that can search its catalog. */
  private async connectorFor(
    tenantId: string,
  ): Promise<CrmConnector | undefined> {
    const rows = await this.prisma.tenantConnector.findMany({
      where: { tenantId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    for (const row of rows) {
      try {
        const connector = this.loader.create(row);
        if (connector.capabilities.search) return connector;
      } catch (error: unknown) {
        this.logger.warn(
          JSON.stringify({
            event: 'agent.connector_unavailable',
            tenant: tenantId,
            connector: row.connectorKey as TenantConnectorKey,
            name: (error as Error).name,
          }),
        );
      }
    }
    return undefined;
  }
}

function slotState(raw: unknown): SlotState {
  const parsed = ConversationSlotsSchema.safeParse(raw);
  if (!parsed.success) return {};
  const state: Record<string, SlotState[string]> = {};
  for (const [key, entry] of Object.entries(parsed.data.slots)) {
    if (
      (entry.source === 'customer' || entry.source === 'inferred') &&
      (typeof entry.value === 'string' || typeof entry.value === 'number')
    ) {
      state[key] = { value: entry.value, source: entry.source };
    }
  }
  return state;
}
