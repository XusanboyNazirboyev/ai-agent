import type { DomainPack } from '@agentcore/shared';
import type { CrmConnector } from '../../connectors/interfaces/crm-connector.js';
import {
  BudgetExhaustedError,
  type BudgetSnapshot,
  type BudgetStopReason,
} from '../llm/budget.js';
import { isLlmError, type LlmMessage } from '../llm/llm-provider.js';
import type { MeteredLlm } from '../llm/metered-llm.js';
import type {
  HandoverReason,
  LocaleId,
  LocalePack,
  LocaleRegistry,
} from '../locales/locale-pack.js';
import { FactStore, type Fact } from './facts.js';
import { checkDraft, type GuardrailViolation } from './guardrails.js';
import {
  chooseLocale,
  detectLanguage,
  LOCALE_SWITCH_CONFIDENCE,
  type LanguageDetection,
} from './language.js';
import {
  extractionSystemPrompt,
  extractionUserMessage,
  regenerationMessage,
  responseSystemPrompt,
  responseUserMessage,
  type HistoryEntry,
} from './prompts.js';
import {
  detectEnumSlots,
  extractionSchema,
  firstMissing,
  mergeSlots,
  type Intent,
  type SlotState,
} from './slots.js';
import { AgentTools, type ToolOutcome, type ToolTraceEntry } from './tools.js';

/**
 * One customer turn (AGENTS.md §7). Code makes every decision:
 *  1. detect language/script and choose the reply locale;
 *  2. ask the model (FAST tier) for candidate slots and intent, then
 *     validate them against the Domain Pack;
 *  3. route handover intents, or ask the first missing search slot (one
 *     question, no interrogation);
 *  4. once the minimum slots exist, search the catalog (value early), and
 *     try one relaxed search before reporting no results;
 *  5. let the model (STRONG tier) propose further read-only tool calls and
 *     draft the reply with fact references, within the tool/call budget;
 *  6. guard the draft, regenerate once if needed, otherwise fall back to a
 *     code-rendered reply. Business facts never come from the model.
 */

export interface AgentTurnInput {
  readonly turnKey: string;
  readonly customerText: string;
  readonly history: readonly HistoryEntry[];
  readonly slots: SlotState;
  readonly conversationLocale?: LocaleId;
  readonly supportedLocales: readonly LocaleId[];
  readonly defaultLocale: LocaleId;
  readonly timeZone: string;
}

export interface AgentDependencies {
  readonly pack: DomainPack;
  readonly locales: LocaleRegistry;
  readonly connector: CrmConnector | undefined;
  readonly llm: MeteredLlm;
  readonly toolTimeoutMs: number;
  readonly maxOutputTokens: {
    readonly extract: number;
    readonly respond: number;
  };
  readonly now?: () => Date;
}

export type TurnOutcome =
  'ASKED_SLOT' | 'ANSWERED' | 'NO_RESULTS' | 'HANDOVER' | 'FALLBACK';

export interface AgentTurnResult {
  readonly reply: string;
  readonly locale: LocaleId;
  readonly slots: SlotState;
  readonly outcome: TurnOutcome;
  readonly intent: Intent | undefined;
  readonly handover?: HandoverReason;
  readonly askedSlot?: string;
  readonly facts: readonly Fact[];
  readonly violations: readonly GuardrailViolation[];
  readonly regenerated: boolean;
  readonly extractionFailure?: string;
  readonly budget: BudgetSnapshot;
  readonly budgetStop?: BudgetStopReason;
  readonly tools: readonly ToolTraceEntry[];
  readonly language: LanguageDetection;
}

const HANDOVER_INTENTS: Partial<Record<Intent, HandoverReason>> = {
  human_request: 'CUSTOMER_REQUEST',
  complaint: 'COMPLAINT',
  negotiation: 'NEGOTIATION',
  account_question: 'AUTH_REQUIRED',
};

type Draft =
  | {
      readonly kind: 'draft';
      readonly text: string;
      readonly messages: LlmMessage[];
    }
  | { readonly kind: 'refusal' | 'truncated' | 'budget' | 'error' };

export async function runAgentTurn(
  input: AgentTurnInput,
  deps: AgentDependencies,
): Promise<AgentTurnResult> {
  const now = deps.now ?? ((): Date => new Date());
  const { pack, locales, llm } = deps;
  const facts = new FactStore();
  const language = detectLanguage(input.customerText);
  let localeId = chooseLocale(language, {
    current: input.conversationLocale,
    supported: input.supportedLocales,
    fallback: input.defaultLocale,
    registry: locales,
  });
  let slots: SlotState = input.slots;
  let intent: Intent | undefined;
  let extractionFailure: string | undefined;
  let llmAvailable = true;
  const tools = deps.connector
    ? new AgentTools({
        connector: deps.connector,
        pack,
        facts,
        budget: llm.budget,
        timeoutMs: deps.toolTimeoutMs,
        now,
      })
    : undefined;

  const locale = (): LocalePack => locales.get(localeId);
  const finish = (
    reply: string,
    outcome: TurnOutcome,
    extra: Partial<AgentTurnResult> = {},
  ): AgentTurnResult => ({
    reply,
    locale: localeId,
    slots,
    outcome,
    intent,
    facts: facts.list(),
    violations: [],
    regenerated: false,
    extractionFailure,
    budget: llm.budget.snapshot,
    budgetStop: llm.budget.snapshot.stopReason,
    tools: tools?.trace ?? [],
    language,
    ...extra,
  });
  const handover = (
    reason: HandoverReason,
    extra: Partial<AgentTurnResult> = {},
  ): AgentTurnResult =>
    finish(locale().templates.handover[reason], 'HANDOVER', {
      handover: reason,
      ...extra,
    });

  // 1-2. Candidate slots: deterministic enum matches plus model extraction.
  const deterministic = detectEnumSlots(pack, input.customerText);
  let proposed: Record<string, string | null> = { ...deterministic };
  try {
    const { schema, jsonSchema } = extractionSchema(pack);
    const result = await llm.structured({
      tier: 'FAST',
      purpose: 'extract',
      system: extractionSystemPrompt(pack),
      messages: [
        {
          role: 'user',
          text: extractionUserMessage(input.history, input.customerText),
        },
      ],
      schemaName: 'turn_extraction',
      schema,
      jsonSchema,
      maxOutputTokens: deps.maxOutputTokens.extract,
    });
    if (result.value) {
      intent = result.value.intent;
      const fromModel = Object.fromEntries(
        Object.entries(result.value.slots).filter(
          ([, value]) => value !== null,
        ),
      );
      proposed = { ...deterministic, ...fromModel };
      const { language: lang, script } = result.value;
      if (
        input.conversationLocale === undefined &&
        language.confidence < LOCALE_SWITCH_CONFIDENCE &&
        lang !== 'other' &&
        script !== 'other'
      ) {
        const match = locales.find(lang, script);
        if (match && input.supportedLocales.includes(match.id))
          localeId = match.id;
      }
    } else {
      extractionFailure = result.failure;
      if (result.failure === 'refusal') return handover('GUARDRAIL');
    }
  } catch (error: unknown) {
    if (error instanceof BudgetExhaustedError) {
      return handover('BUDGET_EXHAUSTED', { budgetStop: error.reason });
    }
    if (!isLlmError(error)) throw error;
    // Provider down: continue deterministically and never improvise facts.
    extractionFailure = error.code;
    llmAvailable = false;
  }
  const merged = mergeSlots(pack, slots, proposed);
  slots = merged.state;
  const invalid = merged.invalid;

  // 3. Handover intents and missing search information.
  const reason = intent ? HANDOVER_INTENTS[intent] : undefined;
  if (reason) return handover(reason);

  const missing = firstMissing(pack, slots, 'search');
  if (missing) {
    const prefix = invalid.includes(missing.key)
      ? `${locale().templates.notUnderstood} `
      : intent === 'greeting' ||
          (intent === undefined && input.history.length === 0)
        ? `${locale().templates.greeting} `
        : '';
    return finish(
      `${prefix}${missing.questions[localeId] ?? ''}`.trim(),
      'ASKED_SLOT',
      {
        askedSlot: missing.key,
      },
    );
  }

  // 4. Search early, then one relaxed search before giving up.
  if (!tools || !tools.available().includes('search_catalog'))
    return handover('NO_DATA');
  let search: ToolOutcome;
  try {
    search = await tools.searchBySlots(slots);
    if (search.ok && search.items.length === 0) {
      const relaxed = await tools.searchBySlots(slots, true);
      if (relaxed.ok) search = relaxed;
    }
  } catch (error: unknown) {
    if (error instanceof BudgetExhaustedError) {
      return handover('BUDGET_EXHAUSTED', { budgetStop: error.reason });
    }
    throw error;
  }
  if (!search.ok) return handover('NO_DATA');
  if (search.items.length === 0) {
    return finish(
      `${locale().templates.noResults} ${locale().templates.offerOperator}`,
      'NO_RESULTS',
      { handover: 'NO_DATA' },
    );
  }

  const quoteMissing = firstMissing(pack, slots, 'quote');
  const nextQuestion = quoteMissing?.questions[localeId];
  const fallback = (extra: Partial<AgentTurnResult> = {}): AgentTurnResult => {
    const lines = search.ok
      ? search.items
          .slice(0, pack.maxOptionsShown)
          .map((item) => `• ${item.title}`)
      : [];
    const tail = nextQuestion ?? locale().templates.offerOperator;
    return finish(
      [locale().templates.optionsIntro, ...lines, tail].join('\n'),
      'FALLBACK',
      extra,
    );
  };
  if (!llmAvailable) return fallback();

  // 5. Model-proposed tool calls and the reply draft.
  const draft = await respond(deps, tools, {
    system: responseSystemPrompt(pack, locale()),
    user: responseUserMessage({
      history: input.history,
      latest: input.customerText,
      slots,
      searchResults: search.summary,
      nextQuestion,
    }),
  });
  if (draft.kind === 'refusal') return handover('GUARDRAIL');
  if (
    draft.kind === 'budget' &&
    llm.budget.snapshot.stopReason === 'CONVERSATION_COST_LIMIT'
  ) {
    return handover('BUDGET_EXHAUSTED');
  }
  if (draft.kind !== 'draft') return fallback();

  // 6. Guardrail, one regeneration, then a safe code-rendered fallback.
  const guard = (text: string): ReturnType<typeof checkDraft> =>
    checkDraft(text, {
      facts,
      locale: locale(),
      customerTexts: [
        input.customerText,
        ...input.history
          .filter((h) => h.role === 'customer')
          .map((h) => h.text),
      ],
      timeZone: input.timeZone,
      now: now(),
    });
  let checked = guard(draft.text);
  let regenerated = false;
  if (checked.violations.length > 0) {
    regenerated = true;
    const first = checked.violations;
    try {
      const retry = await llm.withTools({
        tier: 'STRONG',
        purpose: 'respond',
        system: responseSystemPrompt(pack, locale()),
        messages: [
          ...draft.messages,
          { role: 'user', text: regenerationMessage(first, locale()) },
        ],
        tools: [],
        maxOutputTokens: deps.maxOutputTokens.respond,
      });
      checked =
        retry.stopReason === 'end' ? guard(retry.text) : { violations: first };
      if (checked.violations.length > 0)
        checked = {
          violations: [...new Set([...first, ...checked.violations])],
        };
    } catch (error: unknown) {
      if (!(error instanceof BudgetExhaustedError) && !isLlmError(error))
        throw error;
      checked = { violations: first };
    }
  }
  if (!checked.rendered)
    return fallback({ violations: checked.violations, regenerated });
  return finish(checked.rendered, 'ANSWERED', { regenerated });
}

/** Bounded tool loop: every round and call is checked against the budget. */
async function respond(
  deps: AgentDependencies,
  tools: AgentTools,
  prompt: { system: string; user: string },
): Promise<Draft> {
  const messages: LlmMessage[] = [{ role: 'user', text: prompt.user }];
  try {
    for (;;) {
      const result = await deps.llm.withTools({
        tier: 'STRONG',
        purpose: 'respond',
        system: prompt.system,
        messages,
        tools: tools.definitions(),
        maxOutputTokens: deps.maxOutputTokens.respond,
      });
      if (result.stopReason === 'refusal') return { kind: 'refusal' };
      if (result.stopReason === 'max_tokens') return { kind: 'truncated' };
      const assistant: LlmMessage = {
        role: 'assistant',
        text: result.text,
        toolCalls: result.toolCalls,
        providerContent: result.providerContent,
      };
      if (result.toolCalls.length === 0) {
        return {
          kind: 'draft',
          text: result.text,
          messages: [...messages, assistant],
        };
      }
      deps.llm.budget.beginToolRound();
      messages.push(assistant);
      const results = [];
      for (const call of result.toolCalls) {
        const outcome = await tools.run(call.name, call.input);
        results.push({
          toolCallId: call.id,
          content: outcome.summary,
          isError: !outcome.ok,
        });
      }
      messages.push({ role: 'tool_results', results });
    }
  } catch (error: unknown) {
    if (error instanceof BudgetExhaustedError) return { kind: 'budget' };
    if (isLlmError(error)) return { kind: 'error' };
    throw error;
  }
}
