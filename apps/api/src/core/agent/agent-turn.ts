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
import { isOptOutMessage } from '../followup/optout.js';
import { decimalAtLeast } from './money.js';
import { decideVoice } from '../speech/speech-to-text.js';
import {
  DEFAULT_STUCK_POLICY,
  detectStuck,
  textFingerprint,
  type PriorTurnSignal,
  type StuckPolicy,
} from './stuck.js';
import type { KnowledgeSearch } from '../knowledge/passage.js';
import { TurnStopwatch, type TurnTimings } from './turn-timings.js';
import {
  ACTION_SLOT_PREFIX,
  confirmationOf,
  planAction,
  proposalDigest,
  renderProposal,
  type ActionDecision,
  type ActionTurnContext,
} from '../actions/actions.js';
import { displayPolicyFor, type DisplayPolicy } from './display-gate.js';
import { FactStore, type Fact } from './facts.js';
import {
  checkDraft,
  titleCarriesHardFact,
  type GuardrailViolation,
} from './guardrails.js';
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
  schedulingSystemPrompt,
  schedulingUserMessage,
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
import type { SchedulingPort } from '../scheduling/scheduling-port.js';
import {
  renderSchedulingDeclined,
  renderSchedulingDone,
  renderSchedulingProposal,
  SCHEDULING_MARK,
  schedulingPayload,
} from '../scheduling/scheduling-render.js';
import { verifiedQuoteDraft } from './verified-answer.js';

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
  /**
   * ADR 042: the answered batch held a voice note that could not be
   * transcribed (its text is empty), with the number of failed voice notes
   * in a row before it.
   */
  readonly voice?: { readonly failed: true; readonly failedBefore: number };
  /**
   * ADR 043: the batch is a public comment. It is answered (in private) only
   * when it asks something or shows interest; otherwise the turn ends with
   * NO_REPLY. Opt-out words, confirmations and business actions never apply.
   */
  readonly origin?: 'public_comment';
  readonly progress?: {
    readonly priorTurns: readonly PriorTurnSignal[];
    readonly stuck?: StuckPolicy;
  };
  /** Business actions this turn may propose or confirm (ADR 024). */
  readonly action?: ActionTurnContext;
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
  /** Monotonic milliseconds for stage timings (default performance.now). */
  readonly clock?: () => number;
  /** Tenant and conversation this turn runs for; stamped on every fact. */
  readonly scope: {
    readonly tenantId: string;
    readonly conversationId: string;
  };
  /** Overrides to the connector-derived display policy (ADR 013). */
  readonly displayPolicy?: Partial<DisplayPolicy>;
  readonly languagePolicy?: LanguagePolicy;
  /** Retrieval over textual knowledge; absent = knowledge_search is not offered. */
  readonly knowledge?: KnowledgeSearch;
  /** Appointment scheduling (ADR 046); absent = the scheduling tools are not offered. */
  readonly scheduling?: SchedulingPort;
}

export type TurnOutcome =
  | 'ASKED_SLOT'
  | 'ANSWERED'
  | 'NO_RESULTS'
  | 'HANDOVER'
  | 'FALLBACK'
  | 'CLARIFICATION_REQUIRED'
  | 'ACTION_PROPOSED'
  | 'ACTION_CONFIRMED'
  | 'ACTION_DECLINED'
  /** ADR 043: a public comment that gets no answer; nothing is sent. */
  | 'NO_REPLY';

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
  /** The customer asked to stop reminders; the commit step records it. */
  readonly optOut?: boolean;
  /** Typed outcome of a safety gate that blocked, clarified or escalated. */
  readonly safety?: SafetyOutcome;
  /** Provider error code when the turn ended because a model call failed. */
  readonly llmFailure?: string;
  /** What the commit step must do with business-action proposals. */
  readonly action?: ActionDecision;
  /** Stage timings; absent for a turn cut off by the caller's deadline. */
  readonly timings?: TurnTimings;
}

/** Intents that show the customer is engaging (ADR 041, STUCK). */
const CONVERSATIONAL_INTENTS: ReadonlySet<Intent> = new Set<Intent>([
  'greeting',
  'search',
  'details',
  'price',
  'availability',
  'booking_interest',
  'ai_question',
  'capabilities',
  'small_talk',
]);

/**
 * ADR 043 (owner decision 2026-11-07): a public comment is answered only when
 * it asks something or shows interest. Praise, emoji, abuse, complaints and
 * requests for a person are left to operators.
 */
const COMMENT_REPLY_INTENTS: ReadonlySet<Intent> = new Set<Intent>([
  'search',
  'details',
  'price',
  'availability',
  'booking_interest',
  'capabilities',
  'regulated_info',
]);

/** ADR 060: intents a knowledge turn cannot answer (commercial facts). */
const KNOWLEDGE_TURN_HANDOVER_INTENTS: ReadonlySet<Intent> = new Set<Intent>([
  'price',
  'availability',
  'booking_interest',
]);

/** Stored as the turn's asked slot so a second frustration in a row is seen. */
export const FRUSTRATION_MARK = 'apology:frustration';

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

/**
 * The locale a reply is written in (D17): a message that the language gate
 * rates HIGH for a supported locale decides it, so the customer is answered in
 * the language and script they just used, even for a one-word greeting
 * ("hello", "привет"). Otherwise the conversation keeps its locale
 * (chooseLocale). One threshold for both: before, a switch needed 0.6 while
 * the gate accepted 0.45, so a short message the gate called clear stayed in
 * the old locale and was then treated as unclear (ADR 013 amendment).
 */
function replyLocale(
  input: AgentTurnInput,
  locales: LocaleRegistry,
  assessment: LanguageAssessment,
): LocaleId {
  if (
    assessment.confidenceClass === 'HIGH' &&
    assessment.localeId !== undefined &&
    input.supportedLocales.includes(assessment.localeId)
  )
    return assessment.localeId;
  return chooseLocale(detectLanguage(input.customerText), {
    current: input.conversationLocale,
    supported: input.supportedLocales,
    fallback: input.defaultLocale,
    registry: locales,
  });
}

export async function runAgentTurn(
  input: AgentTurnInput,
  deps: AgentDependencies,
): Promise<AgentTurnResult> {
  const now = deps.now ?? ((): Date => new Date());
  const stopwatch = new TurnStopwatch(
    deps.clock ?? ((): number => performance.now()),
  );
  const { pack, locales, llm } = deps;
  const facts = new FactStore();
  const language = detectLanguage(input.customerText);
  const languagePolicy = deps.languagePolicy ?? DEFAULT_LANGUAGE_POLICY;
  const languageAssessment = assessLanguage(
    input.customerText,
    locales,
    languagePolicy,
  );
  let localeId = replyLocale(input, locales, languageAssessment);
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
  // ADR 060: without a catalog connector a pack that offers knowledge_search
  // still gets tools, but only that one (no catalog, no scheduling).
  const tools =
    deps.connector ||
    (deps.knowledge && pack.tools.includes('knowledge_search'))
      ? new AgentTools({
          connector: deps.connector,
          pack,
          facts,
          budget: llm.budget,
          timeoutMs: deps.toolTimeoutMs,
          now,
          scope: deps.scope,
          ...(deps.knowledge ? { knowledge: deps.knowledge } : {}),
          ...(deps.connector && deps.scheduling
            ? { scheduling: deps.scheduling }
            : {}),
        })
      : undefined;

  const locale = (): LocalePack => locales.get(localeId);
  // Any message other than an exact confirmation or decline retires the open
  // proposal: what the customer confirms is always what they were shown last.
  let supersede: ActionDecision | undefined;
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
    ...(supersede ? { action: supersede } : {}),
    ...extra,
    timings: stopwatch.snapshot(),
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
    // ADR 041: a customer who asks or talks is not stuck because the bot
    // repeated its question; only a customer repeating the same message is.
    const talking =
      stuck === 'SAME_QUESTION_REPEATED' &&
      intent !== undefined &&
      CONVERSATIONAL_INTENTS.has(intent);
    if (stuck && !talking) {
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
  // ADR 043: a skipped public comment keeps the conversation as it was.
  const fromComment = input.origin === 'public_comment';
  const noReply = (extra: Partial<AgentTurnResult> = {}): AgentTurnResult =>
    build('', 'NO_REPLY', {
      ...(extra.llmFailure ? { llmFailure: extra.llmFailure } : {}),
      ...(extra.budgetStop ? { budgetStop: extra.budgetStop } : {}),
      slots: input.slots,
    });
  const handover = (
    reason: HandoverReason,
    extra: Partial<AgentTurnResult> = {},
  ): AgentTurnResult =>
    // A comment that is not (yet) known to be a question is never answered,
    // not even with a handover notice; operators still see it in the inbox.
    fromComment && (intent === undefined || !COMMENT_REPLY_INTENTS.has(intent))
      ? noReply(extra)
      : finish(locale().templates.handover[reason], 'HANDOVER', {
          handover: reason,
          ...extra,
        });

  // ADR 042: an unreadable voice note is never a customer message. Without
  // other text it is answered by code: ask to type, or after repeated
  // failures a person (core/speech decideVoice); no model call.
  if (input.voice?.failed && input.customerText.trim() === '') {
    const decision = decideVoice(
      { ok: false, code: 'UNINTELLIGIBLE' },
      input.voice.failedBefore,
    );
    return decision.action === 'HANDOVER'
      ? handover('VOICE_UNREADABLE')
      : finish(locale().templates.voiceNotUnderstood, 'CLARIFICATION_REQUIRED');
  }

  // Tier-0 language gate: runs before any metered model call. Clarification
  // keeps the slots and history untouched so the conversation resumes once
  // the customer writes in a supported language.
  const languageStop = (
    decision: LanguageDecision,
  ): AgentTurnResult | undefined => {
    if (decision.action === 'PROCEED') return undefined;
    if (fromComment) return noReply();
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
  // Tier-0: a whole-message opt-out ("/stop") is honoured before any model
  // call, in any supported language, and answered with a fixed template.
  if (!fromComment && isOptOutMessage(input.customerText, locales.all())) {
    return build(locale().templates.optOutConfirmation, 'ANSWERED', {
      optOut: true,
    });
  }
  // Tier-0: an exact confirmation or decline of the open proposal is decided
  // by code, before any model call. A model-classified "yes" never confirms.
  const pending = fromComment ? undefined : input.action?.pending;
  if (pending) {
    const answer = confirmationOf(input.customerText, locales.all());
    // A scheduling change is applied at commit; the reply names exactly what
    // was stored (and is replaced there if the change no longer applies).
    const marked = pending.scheduling
      ? { askedSlot: SCHEDULING_MARK }
      : undefined;
    if (answer === 'CONFIRM')
      return build(
        pending.scheduling
          ? renderSchedulingDone(pending.scheduling, locale(), input.timeZone)
          : locale().templates.actions.received,
        'ACTION_CONFIRMED',
        {
          ...marked,
          action: {
            kind: 'CONFIRM',
            proposalId: pending.id,
            digest: pending.digest,
          },
        },
      );
    if (answer === 'DECLINE')
      return build(
        pending.scheduling
          ? renderSchedulingDeclined(pending.scheduling, locale())
          : locale().templates.actions.declined,
        'ACTION_DECLINED',
        {
          ...marked,
          action: { kind: 'DECLINE', proposalId: pending.id },
        },
      );
    supersede = { kind: 'SUPERSEDE', proposalId: pending.id };
  }
  const early = languageStop(
    decideBeforeModel(languageAssessment, spoken, languagePolicy),
  );
  if (early) return early;
  // 1-2. Candidate slots: deterministic enum matches plus model extraction.
  const deterministic = detectEnumSlots(pack, input.customerText);
  let proposed: Record<string, string | null> = { ...deterministic };
  stopwatch.gatesDone();
  try {
    const { schema, jsonSchema } = extractionSchema(pack);
    const result = await stopwatch.time('extract', () =>
      llm.structured({
        tier: 'FAST',
        purpose: 'extract',
        system: extractionSystemPrompt(pack, locales.all()),
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
      }),
    );
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
  if (
    fromComment &&
    (intent === undefined || !COMMENT_REPLY_INTENTS.has(intent))
  )
    return noReply();
  const merged = mergeSlots(pack, slots, proposed);
  slots = merged.state;
  const invalid = merged.invalid;
  // ADR 046: a scheduling turn starts on a booking intent and continues while
  // the previous reply was part of the same scheduling exchange.
  const schedulingTurn =
    !fromComment &&
    intent !== 'regulated_info' &&
    tools?.available().includes('find_slots') === true &&
    (intent === 'booking_interest' ||
      input.progress?.priorTurns.at(-1)?.askedSlot === SCHEDULING_MARK);

  // 3. Handover intents and missing search information.
  const reason = intent ? HANDOVER_INTENTS[intent] : undefined;
  if (reason) return handover(reason);
  // A request to switch language is acknowledged in the new language by
  // code; its words ("ingliz tilida") are not what the customer asks about,
  // so nothing extracted from it is kept. The facts gate still applies: a
  // request never makes unreadable text understood.
  const previous = past.pinned ?? input.conversationLocale ?? past.established;
  if (requested && requested !== previous) {
    const unclear = languageStop(
      decideBeforeFacts(
        languageAssessment,
        spoken,
        localeId,
        locales,
        modelLocale,
        languagePolicy,
      ),
    );
    if (unclear) return unclear;
    return finish(locale().templates.languageSwitched, 'ANSWERED', {
      slots: input.slots,
    });
  }
  // Truthful AI disclosure when asked (addendum §3.10).
  if (intent === 'ai_question')
    return finish(locale().templates.aiDisclosure, 'ANSWERED');

  // Business action: started by a trigger intent or continued while its
  // fields are being collected. Questions and the proposal are code-rendered.
  const actionContext = fromComment ? undefined : input.action;
  const candidate = actionContext?.available.find(
    (entry) =>
      !schedulingTurn &&
      ((intent !== undefined &&
        (entry.spec.triggerIntents as readonly string[]).includes(intent)) ||
        entry.spec.key === actionContext.collecting),
  );
  if (actionContext && candidate) {
    const plan = planAction(candidate.spec, slots, actionContext.contact);
    if (plan.kind === 'ASK') {
      const field = plan.field;
      const question =
        field.from.kind === 'slot'
          ? pack.slots.find(
              (slot) => slot.key === (field.from as { slot: string }).slot,
            )?.questions[localeId]
          : field.from.field === 'phone'
            ? locale().templates.phoneRequest
            : locale().templates.actions.askName;
      return finish(
        question ?? locale().templates.notUnderstood,
        'ASKED_SLOT',
        {
          askedSlot: `${ACTION_SLOT_PREFIX}${candidate.spec.key}:${field.name}`,
        },
      );
    }
    return finish(
      renderProposal(candidate, plan.payload, locale()),
      'ACTION_PROPOSED',
      {
        action: {
          kind: 'PROPOSE',
          actionKey: candidate.spec.key,
          payload: plan.payload,
          digest: proposalDigest(
            actionContext.scope,
            candidate.spec.key,
            plan.payload,
          ),
          expiresAfterMinutes: candidate.spec.expiresAfterMinutes,
          ...(pending ? { supersedes: pending.id } : {}),
        },
      },
    );
  }

  // ADR 041: "what can you do", small talk and mild frustration are answered
  // by code (no facts), followed by the next missing question. The customer
  // is talking, so these turns are progress and never count toward STUCK.
  // Frustration a second time in a row goes to a person.
  if (
    intent === 'capabilities' ||
    intent === 'small_talk' ||
    intent === 'frustration'
  ) {
    const previous = input.progress?.priorTurns.at(-1);
    if (intent === 'frustration' && previous?.askedSlot === FRUSTRATION_MARK)
      return handover('COMPLAINT');
    const lead =
      intent === 'capabilities'
        ? (pack.capabilities[localeId] ?? locale().templates.capabilities)
        : intent === 'small_talk'
          ? locale().templates.smallTalk
          : locale().templates.frustration;
    const next = firstMissing(pack, slots, 'search');
    const tail = next?.questions[localeId] ?? locale().templates.anythingElse;
    return finish(`${lead} ${tail}`.trim(), 'ANSWERED', {
      askedSlot: intent === 'frustration' ? FRUSTRATION_MARK : next?.key,
    });
  }

  // A question about what the law or an authority requires is answered only
  // from verified, recent regulated knowledge; otherwise nobody answers it but
  // a person. No search slots are asked for it.
  const regulated = intent === 'regulated_info';
  // ADR 060: no catalog tool but a knowledge tool = a knowledge turn. It
  // answers only from retrieved knowledge facts, so there is no catalog
  // search to ask search slots for.
  const knowledgeTurn =
    !regulated &&
    !schedulingTurn &&
    tools !== undefined &&
    !tools.available().includes('search_catalog') &&
    tools.available().includes('knowledge_search');
  const missing =
    regulated || schedulingTurn || knowledgeTurn
      ? undefined
      : firstMissing(pack, slots, 'search');
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

  // A greeting once the search slots are known is answered as a greeting: it
  // asks nothing, so nothing is searched. (On staging, "hello" in a
  // conversation that already had a subject ran the catalog search and ended
  // in a NO_DATA hand-over.)
  if (intent === 'greeting')
    return finish(locale().templates.greeting, 'ANSWERED');

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
  let knowledgeOutcome: ToolOutcome | undefined;
  if (regulated) {
    // Regulated answers stay as before ADR 060: they need the connector-backed
    // tool set, so a knowledge-only tool set hands them over.
    if (
      !tools ||
      !deps.connector ||
      !tools.available().includes('knowledge_search')
    )
      return handover('LEGAL_UNVERIFIED');
    try {
      knowledgeOutcome = await stopwatch.time('search', () =>
        tools.searchKnowledge(input.customerText),
      );
    } catch (error: unknown) {
      if (error instanceof BudgetExhaustedError)
        return handover(budgetHandoverReason(error.reason), {
          budgetStop: error.reason,
        });
      throw error;
    }
    // Verified = a regulated passage whose update date is still inside the
    // pack's limit (its validity ends at updatedAt + regulatedMaxAgeDays).
    const verified = facts
      .list()
      .some(
        (fact) =>
          fact.value.kind === 'knowledge' &&
          fact.value.regulated &&
          (fact.provenance.validUntil === undefined ||
            Date.parse(fact.provenance.validUntil) > now().getTime()),
      );
    if (
      !knowledgeOutcome.ok ||
      knowledgeOutcome.outcome !== 'FOUND' ||
      !verified
    )
      return handover('LEGAL_UNVERIFIED');
  } else if (knowledgeTurn) {
    // Commercial facts (price, availability, booking) exist only as catalog
    // or offer facts, which this tool set has none of: a person answers them.
    // The intent comes from the classifier, never from the customer's words.
    if (intent !== undefined && KNOWLEDGE_TURN_HANDOVER_INTENTS.has(intent))
      return handover('NO_DATA');
    try {
      knowledgeOutcome = await stopwatch.time('search', () =>
        tools.searchKnowledge(input.customerText),
      );
    } catch (error: unknown) {
      if (error instanceof BudgetExhaustedError)
        return handover(budgetHandoverReason(error.reason), {
          budgetStop: error.reason,
        });
      throw error;
    }
    if (
      !knowledgeOutcome.ok ||
      knowledgeOutcome.outcome !== 'FOUND' ||
      !facts.list().some((fact) => fact.value.kind === 'knowledge')
    )
      return handover('NO_DATA');
  } else if (
    !schedulingTurn &&
    (!tools || !tools.available().includes('search_catalog'))
  ) {
    return handover('NO_DATA');
  }
  // A scheduling turn needs no catalog search: its context is the service
  // list and the customer's own appointments (facts), loaded below.
  let search: ToolOutcome = {
    ok: true,
    outcome: 'NOT_FOUND',
    summary: '',
    items: [],
  };
  const searchDone = stopwatch.begin('search');
  try {
    if (schedulingTurn) {
      search = { ...search, summary: await tools!.schedulingContext() };
    } else {
      search = knowledgeOutcome ?? (await tools!.searchBySlots(slots));
      if (!knowledgeOutcome && search.ok && search.items.length === 0) {
        // Same words, canonical Uzbek spelling: only the query is rewritten.
        const variant = tools!.searchByOrthographicVariant(slots);
        if (variant) {
          const alt = await variant;
          if (alt.ok && alt.items.length > 0) search = alt;
        }
      }
      if (!knowledgeOutcome && search.ok && search.items.length === 0) {
        const relaxed = await tools!.searchBySlots(slots, true);
        if (relaxed.ok) search = relaxed;
      }
    }
  } catch (error: unknown) {
    if (error instanceof BudgetExhaustedError) {
      return handover(budgetHandoverReason(error.reason), {
        budgetStop: error.reason,
      });
    }
    throw error;
  } finally {
    searchDone();
  }
  if (!search.ok) {
    // CRM failure is distinct from missing data (addendum §3.4).
    return handover(
      CONNECTOR_FAILURES.has(search.code) ? 'CONNECTOR_UNAVAILABLE' : 'NO_DATA',
    );
  }
  if (!schedulingTurn && !knowledgeOutcome && search.items.length === 0) {
    return finish(
      `${locale().templates.noResults} ${locale().templates.offerOperator}`,
      'NO_RESULTS',
      { handover: 'NO_DATA' },
    );
  }

  // 6. Guardrail (also for the code-rendered fallback below), one
  // regeneration, then a safe code-rendered fallback.
  const guard = (text: string): ReturnType<typeof checkDraft> =>
    stopwatch.timeSync('guardrail', () =>
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
      }),
    );
  const quoteMissing = firstMissing(pack, slots, 'quote');
  const nextQuestion = quoteMissing?.questions[localeId];
  const fallback = (extra: Partial<AgentTurnResult> = {}): AgentTurnResult => {
    const tail = nextQuestion ?? locale().templates.offerOperator;
    // AUD-10: options are title-fact references rendered by code and passed
    // through the same guardrail and display gate as a model draft; a title
    // that states a price or availability is left out.
    const lines = search.ok
      ? search.items.slice(0, pack.maxOptionsShown).flatMap((item) => {
          if (titleCarriesHardFact(item.title, locale())) return [];
          const fact = [...facts.list()]
            .reverse()
            .find(
              (f) =>
                f.value.kind === 'title' &&
                f.value.text === item.title &&
                f.provenance.sourceEntityId === item.sourceEntityId,
            );
          return fact ? [`• {{${fact.id}}}`] : [];
        })
      : [];
    const checked =
      lines.length > 0
        ? guard([locale().templates.optionsIntro, ...lines, tail].join('\n'))
        : undefined;
    return finish(checked?.rendered ?? tail, 'FALLBACK', {
      ...extra,
      shownFactIds: [...(checked?.references ?? [])],
    });
  };

  // 5. Model-proposed tool calls and the reply draft. Items the code found
  // are already in the prompt (id, title, description, attributes), so
  // searching again or asking for their details only costs model rounds
  // (on staging a reply took four rounds and 25 s, two of them repeats).
  if (!knowledgeOutcome && search.ok && search.items.length > 0)
    tools!.withhold(['search_catalog', 'get_item_details']);
  const nowDate = now();
  const systemPrompt = schedulingTurn
    ? schedulingSystemPrompt(pack, locale(), {
        date: localDateIn(nowDate, input.timeZone),
        weekday: new Intl.DateTimeFormat('en', {
          weekday: 'long',
          timeZone: input.timeZone,
        }).format(nowDate),
      })
    : responseSystemPrompt(pack, locale());
  const draft = await respond(deps, tools!, stopwatch, {
    system: systemPrompt,
    user: schedulingTurn
      ? schedulingUserMessage({
          history: input.history,
          latest: input.customerText,
          schedulingContext: search.summary,
        })
      : responseUserMessage({
          history: input.history,
          latest: input.customerText,
          slots,
          searchResults: search.summary,
          nextQuestion,
        }),
  });
  // ADR 046: a tool prepared a booking, cancellation or move. Code asks the
  // customer to confirm it (D4); the model's own wording is dropped.
  const change = tools!.schedulingChange;
  if (change) {
    const scope = {
      tenantId: deps.scope.tenantId,
      conversationId: deps.scope.conversationId,
      packRef: `${pack.key}@${pack.version}`,
    };
    return finish(
      renderSchedulingProposal(
        { operation: change.operation, view: change.view },
        locale(),
        input.timeZone,
      ),
      'ACTION_PROPOSED',
      {
        askedSlot: SCHEDULING_MARK,
        action: {
          kind: 'PROPOSE_SCHEDULED',
          operation: change.operation,
          appointmentId: change.appointmentId,
          ...(change.replacesAppointmentId
            ? { replacesAppointmentId: change.replacesAppointmentId }
            : {}),
          digest: proposalDigest(
            scope,
            `scheduling.${change.operation}`,
            schedulingPayload(change),
          ),
          expiresAtIso: change.expiresAtIso,
          ...(pending ? { supersedes: pending.id } : {}),
        },
      },
    );
  }
  if (draft.kind === 'refusal') return handover('GUARDRAIL');
  if (draft.kind === 'budget')
    return handover(budgetHandoverReason(llm.budget.snapshot.stopReason));
  if (draft.kind === 'error')
    return handover('LLM_UNAVAILABLE', { llmFailure: draft.code });
  // Truncated or empty drafts carry nothing to guard: use the code-rendered
  // option list, which contains only connector facts.
  if (draft.kind !== 'draft' || draft.text.trim() === '') return fallback();

  let checked = guard(draft.text);
  const firstViolations = checked.violations;
  let regenerated = false;
  if (checked.violations.length > 0) {
    regenerated = true;
    const first = checked.violations;
    try {
      const correction: LlmMessage[] = [
        ...draft.messages,
        { role: 'user', text: regenerationMessage(first, locale()) },
      ];
      let retryText: string | undefined;
      if (first.includes('FACT_NOT_LIVE') && tools) {
        // A price that is not live needs a tool call (get_quote), so this retry
        // keeps the tools; the same rounds, budget and guardrail apply.
        const again = await respond(deps, tools, stopwatch, {
          system: systemPrompt,
          messages: correction,
        });
        if (again.kind === 'budget')
          return handover(
            budgetHandoverReason(llm.budget.snapshot.stopReason),
            {
              violations: first,
              regenerated,
            },
          );
        if (again.kind === 'error')
          return handover('LLM_UNAVAILABLE', {
            llmFailure: again.code,
            violations: first,
            regenerated,
          });
        if (again.kind === 'draft') retryText = again.text;
      } else {
        stopwatch.countRound();
        const retry = await stopwatch.time('respond', () =>
          llm.withTools({
            tier: 'STRONG',
            purpose: 'respond',
            system: systemPrompt,
            messages: correction,
            tools: [],
            maxOutputTokens: deps.maxOutputTokens.respond,
          }),
        );
        if (retry.stopReason === 'end') retryText = retry.text;
      }
      checked =
        retryText !== undefined ? guard(retryText) : { violations: first };
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
    // The model could not word an acceptable reply, but a live confirmed quote
    // may exist: answer with just that verified fact, written by code and
    // checked by the same gates. Without one the turn is a handover.
    const verified = verifiedQuoteDraft(facts.list());
    if (verified !== undefined) {
      const safe = guard(verified);
      if (safe.rendered) checked = safe;
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
  // HIGH_VALUE: a confirmed quote at or above the pack's threshold is not
  // sent by the bot; a person confirms it. The verified quote stays in the
  // handover summary for the operator.
  const highValue = pack.highValue;
  if (
    highValue &&
    (checked.references ?? []).some((id) => {
      const fact = facts.get(id);
      return (
        fact?.value.kind === 'price' &&
        fact.value.confirmedQuote &&
        fact.value.money.currency === highValue.currency &&
        decimalAtLeast(fact.value.money.amount, highValue.minAmount)
      );
    })
  ) {
    return handover('HIGH_VALUE', {
      regenerated,
      safety: {
        status: 'ESCALATION_REQUIRED',
        gate: 'PROGRESS',
        reasonCodes: ['HIGH_VALUE_QUOTE'],
        escalation: { reason: 'HIGH_VALUE', operatorNotified: false },
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
      ...(schedulingTurn ? { askedSlot: SCHEDULING_MARK } : {}),
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

/** Local calendar date `YYYY-MM-DD` of an instant in a time zone. */
function localDateIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Bounded tool loop: every round and call is checked against the budget. */
async function respond(
  deps: AgentDependencies,
  tools: AgentTools,
  stopwatch: TurnStopwatch,
  prompt: { system: string } & (
    | { user: string; messages?: undefined }
    | { messages: readonly LlmMessage[]; user?: undefined }
  ),
): Promise<Draft> {
  return stopwatch.time('respond', () =>
    respondLoop(deps, tools, stopwatch, prompt),
  );
}

async function respondLoop(
  deps: AgentDependencies,
  tools: AgentTools,
  stopwatch: TurnStopwatch,
  prompt: { system: string } & (
    | { user: string; messages?: undefined }
    | { messages: readonly LlmMessage[]; user?: undefined }
  ),
): Promise<Draft> {
  const messages: LlmMessage[] = prompt.messages
    ? [...prompt.messages]
    : [{ role: 'user', text: prompt.user }];
  try {
    for (;;) {
      stopwatch.countRound();
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
        stopwatch.countToolExecution();
        const outcome = await stopwatch.time('respondTool', () =>
          tools.run(call.name, call.input),
        );
        results.push({
          toolCallId: call.id,
          content: outcome.summary,
          isError: !outcome.ok,
        });
      }
      messages.push({ role: 'tool_results', results });
      // A prepared scheduling change ends the turn: code asks for confirmation.
      if (tools.schedulingChange)
        return { kind: 'draft', text: '', messages: [...messages] };
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
  const localeId = replyLocale(
    input,
    locales,
    assessLanguage(input.customerText, locales, DEFAULT_LANGUAGE_POLICY),
  );
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
