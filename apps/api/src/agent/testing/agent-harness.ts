import type { DomainPack } from '@agentcore/shared';
import type { CrmConnector } from '../../connectors/interfaces/crm-connector.js';
import { MockConnector } from '../../connectors/mock/mock-connector.js';
import { allFixtures } from '../../connectors/mock/mock-fixtures.js';
import { INITIAL_LOCALE_PACKS } from '../../locales/locale-packs.js';
import { EDUCATION_PACK } from '../../packs/education/education.pack.js';
import { TurnBudget, type BudgetLimits } from '../../core/llm/budget.js';
import type { LlmProvider } from '../../core/llm/llm-provider.js';
import { MeteredLlm, type LlmUsageEntry } from '../../core/llm/metered-llm.js';
import { usdToNano } from '../../core/llm/pricing.js';
import {
  DEFAULT_PRICING_VERSION,
  PRICING_CATALOG,
} from '../../llm/pricing-catalog.js';
import {
  LocaleRegistry,
  type LocaleId,
} from '../../core/locales/locale-pack.js';
import {
  runAgentTurn,
  type AgentTurnInput,
  type AgentTurnResult,
} from '../../core/agent/agent-turn.js';

/** Test-only wiring of the agent core with fictional data. */

export const TEST_LIMITS: BudgetLimits = {
  maxTurnCostNano: usdToNano('0.02'),
  maxConversationCostNano: usdToNano('0.25'),
  maxCallsPerTurn: 6,
  maxToolRoundsPerTurn: 3,
  maxToolCallsPerTurn: 6,
  maxOutputTokensPerCall: 1_024,
  maxInputBytesPerCall: 48_000,
};

export const LOCALES = new LocaleRegistry(INITIAL_LOCALE_PACKS);

export function educationConnector(
  overrides: Partial<ConstructorParameters<typeof MockConnector>[1]> = {},
): MockConnector {
  return new MockConnector(
    { tenantId: 'tenant-eval', connectorKey: 'mock' },
    {
      sourceSystem: 'mock-education',
      items: allFixtures('mock-education'),
      ...overrides,
    },
  );
}

export interface TurnRun {
  readonly result: AgentTurnResult;
  readonly usage: readonly LlmUsageEntry[];
  readonly budget: TurnBudget;
}

export async function runTurn(options: {
  provider: LlmProvider;
  text: string;
  connector?: CrmConnector | null;
  pack?: DomainPack;
  limits?: Partial<BudgetLimits>;
  conversationSpentNano?: number;
  /** Spend already counted against `limits.tenantMonthlyBudgetNano`. */
  tenantMonthSpentNano?: number;
  input?: Partial<AgentTurnInput>;
  now?: Date;
}): Promise<TurnRun> {
  const usage: LlmUsageEntry[] = [];
  const budget = new TurnBudget(
    { ...TEST_LIMITS, ...options.limits },
    {
      conversationSpentNano: options.conversationSpentNano ?? 0,
      tenantMonthSpentNano: options.tenantMonthSpentNano ?? 0,
    },
  );
  const llm = new MeteredLlm(
    options.provider,
    PRICING_CATALOG.snapshot(DEFAULT_PRICING_VERSION),
    budget,
    { record: async (entry): Promise<void> => void usage.push(entry) },
    {
      tenantId: 'tenant-eval',
      conversationId: 'conversation-eval',
      turnKey: 'turn-1',
    },
  );
  const now = options.now ?? new Date('2026-10-23T10:00:00Z');
  const result = await runAgentTurn(
    {
      turnKey: 'turn-1',
      customerText: options.text,
      history: [],
      slots: {},
      supportedLocales: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'] satisfies LocaleId[],
      defaultLocale: 'uz-Latn',
      timeZone: 'Asia/Tashkent',
      ...options.input,
    },
    {
      pack: options.pack ?? EDUCATION_PACK,
      locales: LOCALES,
      connector:
        options.connector === null
          ? undefined
          : (options.connector ?? educationConnector()),
      llm,
      toolTimeoutMs: 200,
      maxOutputTokens: { extract: 600, respond: 900 },
      now: () => now,
    },
  );
  return { result, usage, budget };
}

/** A schema-valid extraction with the given slots and intent. */
export function extraction(
  slots: Record<string, string | null>,
  intent = 'search',
  language = 'uz',
  script = 'Latn',
): { kind: 'structured'; value: unknown } {
  const all = Object.fromEntries(
    EDUCATION_PACK.slots.map((slot) => [slot.key, null]),
  );
  return {
    kind: 'structured',
    value: { language, script, intent, slots: { ...all, ...slots } },
  };
}
