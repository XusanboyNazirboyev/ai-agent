import { Inject, Injectable, Logger } from '@nestjs/common';
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
  runAgentTurn,
  type AgentTurnResult,
} from '../core/agent/agent-turn.js';
import type { HistoryEntry } from '../core/agent/prompts.js';
import type { SlotState } from '../core/agent/slots.js';
import { TurnBudget } from '../core/llm/budget.js';
import type { LlmProvider } from '../core/llm/llm-provider.js';
import { MeteredLlm } from '../core/llm/metered-llm.js';
import { LocaleRegistry, type LocaleId } from '../core/locales/locale-pack.js';
import { INITIAL_LOCALE_PACKS } from '../locales/locale-packs.js';
import { EDUCATION_PACK } from '../packs/education/education.pack.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { budgetLimits, llmEnvironment } from './llm.factory.js';
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

export interface CustomerTurn {
  readonly tenantId: string;
  readonly conversationId: string;
  /** Stable id of the inbound message(s) this turn answers. */
  readonly turnKey: string;
  readonly text: string;
}

/**
 * Loads tenant-scoped conversation context, runs one agent turn, and saves
 * the resulting slots and locale. It returns the reply but does not send it:
 * channel delivery stays with the channel's durable outbox.
 */
@Injectable()
export class AgentConversationService {
  private readonly logger = new Logger(AgentConversationService.name);
  private readonly locales = new LocaleRegistry(INITIAL_LOCALE_PACKS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly loader: TenantConnectorLoader,
    private readonly usage: LlmUsageStore,
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  async handleCustomerMessage(turn: CustomerTurn): Promise<AgentTurnResult> {
    const { tenantId, conversationId } = turn;
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });
    if (!tenant) throw new AgentConfigurationError('Unknown tenant');
    const pack = DOMAIN_PACKS.get(`${tenant.packKey}@${tenant.packVersion}`);
    if (!pack)
      throw new AgentConfigurationError(
        `Domain pack ${tenant.packKey}@${tenant.packVersion} is not registered`,
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

    const [slotRow, recent, connector, conversationSpent, monthSpent] =
      await Promise.all([
        this.prisma.conversationSlots.findFirst({
          where: { tenantId, conversationId },
          orderBy: { version: 'desc' },
        }),
        this.prisma.message.findMany({
          where: { tenantId, conversationId },
          orderBy: { sequence: 'desc' },
          take: this.config.get('AGENT_HISTORY_MESSAGES', { infer: true }),
          select: { direction: true, text: true },
        }),
        this.connectorFor(tenantId),
        this.usage.conversationSpendNano(tenantId, conversationId),
        this.usage.tenantMonthSpendNano(tenantId),
      ]);
    const slots = this.slotState(slotRow?.slots);
    const history: HistoryEntry[] = recent.reverse().map((message) => ({
      role: message.direction === 'INBOUND' ? 'customer' : 'agent',
      text: message.text,
    }));

    const environment = llmEnvironment(this.config);
    const budget = new TurnBudget(budgetLimits(environment), {
      conversationSpentNano: conversationSpent,
      tenantMonthSpentNano: monthSpent,
    });
    const llm = new MeteredLlm(
      this.provider,
      this.config.get('LLM_PRICING_VERSION', { infer: true }),
      budget,
      this.usage,
      { tenantId, conversationId, turnKey: turn.turnKey },
      (error) =>
        this.logger.error(
          JSON.stringify({
            event: 'agent.usage_record_failed',
            tenant: tenantId,
            name: (error as Error).name,
          }),
        ),
    );

    const maxOutput = environment.LLM_MAX_OUTPUT_TOKENS;
    const result = await runAgentTurn(
      {
        turnKey: turn.turnKey,
        customerText: turn.text,
        history,
        slots,
        conversationLocale: current,
        supportedLocales: supported,
        defaultLocale,
        timeZone: tenant.timezone,
      },
      {
        pack,
        locales: this.locales,
        connector,
        llm,
        toolTimeoutMs: this.config.get('AGENT_TOOL_TIMEOUT_MS', {
          infer: true,
        }),
        maxOutputTokens: {
          extract: Math.min(600, maxOutput),
          respond: maxOutput,
        },
      },
    );

    await this.persist(
      tenantId,
      conversationId,
      slotRow?.version ?? 0,
      slots,
      result,
    );
    this.logger.log(
      JSON.stringify({
        event: 'agent.turn',
        tenant: tenantId,
        conversation: conversationId,
        outcome: result.outcome,
        locale: result.locale,
        handover: result.handover,
        intent: result.intent,
        costNano: result.budget.spentNano,
        calls: result.budget.calls,
        toolCalls: result.budget.toolCalls,
        budgetStop: result.budgetStop,
        violations: result.violations,
        overshootNano: result.budget.overshootNano,
      }),
    );
    return result;
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

  private slotState(raw: unknown): SlotState {
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

  private async persist(
    tenantId: string,
    conversationId: string,
    version: number,
    before: SlotState,
    result: AgentTurnResult,
  ): Promise<void> {
    const locale = this.locales.get(result.locale);
    await this.prisma.$transaction(async (tx) => {
      if (JSON.stringify(before) !== JSON.stringify(result.slots)) {
        const next = version + 1;
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
    });
  }
}
