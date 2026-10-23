import { normalizeForMatching, type DomainPack } from '@agentcore/shared';
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
import {
  DEFAULT_STUCK_POLICY,
  detectStuck,
  textFingerprint,
  type PriorTurnSignal,
  type StuckPolicy,
} from './stuck.js';
import { displayPolicyFor, type DisplayPolicy } from './display-gate.js';
import { FactStore, type Fact } from './facts.js';
import { checkDraft, type GuardrailViolation } from './guardrails.js';
import {
  chooseLocale,
  detectLanguage,
  LOCALE_SWITCH_CONFIDENCE,
  type LanguageDetection,
} from './language.js';
import {
  assessLanguage,
  DEFAULT_LANGUAGE_POLICY,
  decideBeforeFacts,
  decideBeforeModel,
  languageHistory,
  requestedLocale,
  type LanguageAssessment,
  type LanguageDecision,
  type LanguagePolicy,
} from './language-policy.js';
import {
  extractionSystemPrompt,
  extractionUserMessage,
  regenerationMessage,
  responseSystemPrompt,
  responseUserMessage,
  type HistoryEntry,
} from './prompts.js';
import type { SafetyOutcome } from './safety.js';
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
 *  6. guard the draft and regenerate once if needed; a draft that fails
 *     twice hands over (GUARDRAIL). Business facts never come from the model.
 *
 * Failure policy: every failure ends in a locale template that only says
 * the message was recorded, with a distinct handover reason:
 * LLM_UNAVAILABLE (provider error/timeout), BUDGET_EXCEEDED (cost, call or
 * prompt-size limit), TOOL_LOOP_LIMIT (tool round/call limit),
 * CONNECTOR_UNAVAILABLE (CRM unreachable or invalid), NO_DATA (no data
 * source or record), GUARDRAIL (refusal or two rejected drafts).
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
  /**
   * Progress signals for the STUCK trigger and the contact request, supplied
   * by the conversation layer from stored turns (oldest first).
   */
  readonly progress?: {
    readonly priorTurns: readonly PriorTurnSignal[];
    readonly stuck?: StuckPolicy;
  };
  /** What is known about the contact; absent = never ask for a phone. */
  readonly contact?: {
    readonly hasPhone: boolean;
    readonly phoneRequested: boolean;
  };
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
  /** Tenant and conversation this turn runs for; stamped on every fact. */
  readonly scope: {
    readonly tenantId: string;
    readonly conversationId: string;
  };
  /** Overrides to the connector-derived display policy (ADR 013). */
  readonly displayPolicy?: Partial<DisplayPolicy>;
  readonly languagePolicy?: LanguagePolicy;
}

export type TurnOutcome =
  | 'ASKED_SLOT'
  | 'ANSWERED'
  | 'NO_RESULTS'
  | 'HANDOVER'
  | 'FALLBACK'
  | 'CLARIFICATION_REQUIRED';

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
  readonly languageAssessment?: LanguageAssessment;
  /** Why the STUCK trigger fired, when it did. */
  readonly stuckReason?: string;
  /** Fingerprint of the normalized customer text (no raw text kept). */
  readonly textFingerprint: string;
  /** Fact ids that appear in the final reply (offers-shown tracking). */
  readonly shownFactIds: readonly string[];
  /** True when this reply asked the customer for a phone number. */
  readonly phoneRequested?: boolean;
  /** Typed outcome of a safety gate that blocked, clarified or escalated. */
  readonly safety?: SafetyOutcome;
  /** Provider error code when the turn ended because a model call failed. */
  readonly llmFailure?: string;
}

const HANDOVER_INTENTS: Partial<Record<Intent, HandoverReason>> = {
  human_request: 'CUSTOMER_REQUEST',
  complaint: 'COMPLAINT',
  negotiation: 'NEGOTIATION',
  account_question: 'AUTH_REQUIRED',
};

/** Tool-loop limits are distinct from cost/size limits for operators. */
export function budgetHandoverReason(
  reason: BudgetStopReason | undefined,
): HandoverReason {
  return reason === 'TOOL_ROUND_LIMIT' || reason === 'TOOL_CALL_LIMIT'
    ? 'TOOL_LOOP_LIMIT'
    : 'BUDGET_EXCEEDED';
}

const CONNECTOR_FAILURES: ReadonlySet<string> = new Set([
  'TIMEOUT',
  'UNAVAILABLE',
  'INVALID_OUTPUT',
]);

type Draft =
  | {
      readonly kind: 'draft';
      readonly text: string;
      readonly messages: LlmMessage[];
    }
  | { readonly kind: 'refusal' | 'truncated' | 'budget' }
  | { readonly kind: 'error'; readonly code: string };

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
  const languagePolicy = deps.languagePolicy ?? DEFAULT_LANGUAGE_POLICY;
  const languageAssessment = assessLanguage(
    input.customerText,
    locales,
    languagePolicy,
  );
  // An explicit request ("write in Russian") outranks detection, now and
  // until the customer asks for another language.
  const requested = requestedLocale(
    input.customerText,
    locales,
    input.supportedLocales,
  );
  const past = languageHistory(
    input.history,
    locales,
    languagePolicy,
    input.supportedLocales,
  );
  const spoken: typeof past = requested ? { ...past, pinned: requested } : past;
  const pin = requested ?? past.pinned;
  if (pin) localeId = pin;
  let modelLocale: LocaleId | undefined;
  let slots: SlotState = input.slots;
  let intent: Intent | undefined;
  let extractionFailure: string | undefined;
  const tools = deps.connector
    ? new AgentTools({
        connector: deps.connector,
        pack,
        facts,
        budget: llm.budget,
        timeoutMs: deps.toolTimeoutMs,
        now,
        scope: deps.scope,
      })
    : undefined;

  const locale = (): LocalePack => locales.get(localeId);
  const fingerprint = textFingerprint(normalizeForMatching(input.customerText));
  const build = (
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
    languageAssessment,
    textFingerprint: fingerprint,
    shownFactIds: [],
    ...extra,
  });
  const finish = (
    reply: string,
    outcome: TurnOutcome,
    extra: Partial<AgentTurnResult> = {},
  ): AgentTurnResult => {
    // STUCK: the same lack of progress for `repeatLimit` earlier turns ends in
    // a typed handover instead of asking or answering the same thing again.
    const stuck = input.progress
      ? detectStuck(
          input.progress.priorTurns,
          {
            outcome,
            askedSlot: extra.askedSlot,
            slotsFilled: Object.keys(extra.slots ?? slots).length,
            textFingerprint: fingerprint,
          },
          input.progress.stuck ?? DEFAULT_STUCK_POLICY,
        )
      : undefined;
    if (stuck) {
      return build(locale().templates.handover.STUCK, 'HANDOVER', {
        handover: 'STUCK',
        stuckReason: stuck,
        slots: extra.slots ?? slots,
        safety: {
          status: 'ESCALATION_REQUIRED',
          gate: 'PROGRESS',
          reasonCodes: [stuck],
          escalation: { reason: 'STUCK', operatorNotified: false },
        },
      });
    }
    return build(reply, outcome, extra);
  };
  const handover = (
    reason: HandoverReason,
    extra: Partial<AgentTurnResult> = {},
  ): AgentTurnResult =>
    finish(locale().templates.handover[reason], 'HANDOVER', {
      handover: reason,
      ...extra,
    });

  // Tier-0 language gate: runs before any metered model call. Clarification
  // keeps the slots and history untouched so the conversation resumes once
  // the customer writes in a supported language.
  const languageStop = (
    decision: LanguageDecision,
  ): AgentTurnResult | undefined => {
    if (decision.action === 'PROCEED') return undefined;
    if (decision.action === 'CLARIFY') {
      return finish(
        locale().templates.languageClarification,
        'CLARIFICATION_REQUIRED',
        {
          // Nothing extracted from a message we could not read reliably is
          // kept; the history still carries it for the next turn.
          slots: input.slots,
          safety: {
            status: 'CLARIFICATION_REQUIRED',
            gate: 'LANGUAGE',
            reasonCodes: decision.reasonCodes,
          },
        },
      );
    }
    return handover('LOW_LANG_CONFIDENCE', {
      slots: input.slots,
      safety: {
        status: 'ESCALATION_REQUIRED',
        gate: 'LANGUAGE',
        reasonCodes: decision.reasonCodes,
        escalation: { reason: 'LOW_LANG_CONFIDENCE', operatorNotified: false },
      },
    });
  };
  const early = languageStop(
    decideBeforeModel(languageAssessment, spoken, languagePolicy),
  );
  if (early) return early;

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
      if (lang !== 'other' && script !== 'other')
        modelLocale = locales.find(lang, script)?.id;
      if (
        pin === undefined &&
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
      return handover(budgetHandoverReason(error.reason), {
        budgetStop: error.reason,
      });
    }
    if (!isLlmError(error)) throw error;
    // Provider down or timed out: acknowledge and hand over, never improvise.
    extractionFailure = error.code;
    return handover('LLM_UNAVAILABLE', { llmFailure: error.code });
  }
  const merged = mergeSlots(pack, slots, proposed);
  slots = merged.state;
  const invalid = merged.invalid;

  // 3. Handover intents and missing search information.
  const reason = intent ? HANDOVER_INTENTS[intent] : undefined;
  if (reason) return handover(reason);
  // Truthful AI disclosure when asked (addendum §3.10).
  if (intent === 'ai_question')
    return finish(locale().templates.aiDisclosure, 'ANSWERED');

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

  // Commercial facts need a language the customer demonstrably uses.
  const unsure = languageStop(
    decideBeforeFacts(
      languageAssessment,
      spoken,
      localeId,
      locales,
      modelLocale,
      languagePolicy,
    ),
  );
  if (unsure) return unsure;

  // 4. Search early, then one relaxed search before giving up.
  if (!tools || !tools.available().includes('search_catalog'))
    return handover('NO_DATA');
  let search: ToolOutcome;
  try {
    search = await tools.searchBySlots(slots);
    if (search.ok && search.items.length === 0) {
      // Same words, canonical Uzbek spelling: only the query is rewritten.
      const variant = tools.searchByOrthographicVariant(slots);
      if (variant) {
        const alt = await variant;
        if (alt.ok && alt.items.length > 0) search = alt;
      }
    }
    if (search.ok && search.items.length === 0) {
      const relaxed = await tools.searchBySlots(slots, true);
      if (relaxed.ok) search = relaxed;
    }
  } catch (error: unknown) {
    if (error instanceof BudgetExhaustedError) {
      return handover(budgetHandoverReason(error.reason), {
        budgetStop: error.reason,
      });
    }
    throw error;
  }
  if (!search.ok) {
    // CRM failure is distinct from missing data (addendum §3.4).
    return handover(
      CONNECTOR_FAILURES.has(search.code) ? 'CONNECTOR_UNAVAILABLE' : 'NO_DATA',
    );
  }
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
  if (draft.kind === 'budget')
    return handover(budgetHandoverReason(llm.budget.snapshot.stopReason));
  if (draft.kind === 'error')
    return handover('LLM_UNAVAILABLE', { llmFailure: draft.code });
  // Truncated or empty drafts carry nothing to guard: use the code-rendered
  // option list, which contains only connector facts.
  if (draft.kind !== 'draft' || draft.text.trim() === '') return fallback();

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
      evidence: {
        tenantId: deps.scope.tenantId,
        conversationId: deps.scope.conversationId,
        policy: displayPolicyFor(
          // Strictest policy when no connector is wired (cannot happen here:
          // a draft exists only after a connector search).
          deps.connector?.capabilities ?? {
            liveQuote: true,
            availability: true,
          },
          deps.displayPolicy,
        ),
      },
    });
  let checked = guard(draft.text);
  const firstViolations = checked.violations;
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
      if (error instanceof BudgetExhaustedError) {
        return handover(budgetHandoverReason(error.reason), {
          budgetStop: error.reason,
          violations: first,
          regenerated,
        });
      }
      if (!isLlmError(error)) throw error;
      return handover('LLM_UNAVAILABLE', {
        llmFailure: error.code,
        violations: first,
        regenerated,
      });
    }
  }
  if (!checked.rendered) {
    return handover('GUARDRAIL', {
      violations: checked.violations,
      regenerated,
      safety: {
        status: 'ESCALATION_REQUIRED',
        gate: 'DISPLAY',
        reasonCodes: checked.violations,
        escalation: { reason: 'GUARDRAIL', operatorNotified: false },
      },
    });
  }
  // One polite request for a phone number, after value was delivered and
  // never twice: a fixed template without numbers or promises.
  const askPhone =
    input.contact !== undefined &&
    !input.contact.hasPhone &&
    !input.contact.phoneRequested &&
    (checked.references?.length ?? 0) > 0;
  return finish(
    askPhone
      ? `${checked.rendered}\n\n${locale().templates.phoneRequest}`
      : checked.rendered,
    'ANSWERED',
    {
      shownFactIds: [...(checked.references ?? [])],
      ...(askPhone ? { phoneRequested: true } : {}),
      regenerated,
      ...(firstViolations.length > 0
        ? {
            safety: {
              status: 'BLOCKED' as const,
              gate: 'DISPLAY' as const,
              reasonCodes: firstViolations,
            },
          }
        : {}),
    },
  );
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
    if (isLlmError(error)) return { kind: 'error', code: error.code };
    throw error;
  }
}

/**
 * Result for a turn cut off by the caller's deadline: the same locale choice
 * as a normal turn, the input slots unchanged, and a handover template. Any
 * work still running in the background is ignored by the caller.
 */
export function interruptedTurnResult(
  input: AgentTurnInput,
  locales: LocaleRegistry,
  budget: BudgetSnapshot,
  reason: HandoverReason,
  llmFailure: string,
): AgentTurnResult {
  const language = detectLanguage(input.customerText);
  const localeId = chooseLocale(language, {
    current: input.conversationLocale,
    supported: input.supportedLocales,
    fallback: input.defaultLocale,
    registry: locales,
  });
  return {
    reply: locales.get(localeId).templates.handover[reason],
    locale: localeId,
    slots: input.slots,
    outcome: 'HANDOVER',
    intent: undefined,
    handover: reason,
    facts: [],
    violations: [],
    regenerated: false,
    budget,
    budgetStop: budget.stopReason,
    tools: [],
    language,
    textFingerprint: textFingerprint(normalizeForMatching(input.customerText)),
    shownFactIds: [],
    llmFailure,
  };
}
