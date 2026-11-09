/**
 * Voice turn engine (ADR 045 slice 3, step 2): the `TurnResponder` a call
 * uses. One streaming tool-calling generation per round on the voice FAST
 * model; every sentence is checked and rendered by code before it is
 * spoken (D5), so a blocked sentence is never heard.
 *
 * - Facts: only `{{F<n>}}` references to this turn's tool results, rendered
 *   by code; numbers, dates, prices and contacts the model writes itself
 *   (in digits or in words) block the sentence (`spoken-guardrail.ts`).
 * - Blocked sentence: the reply is regenerated once per turn (after a
 *   partial answer, as a continuation); a second block hands over
 *   (GUARDRAIL).
 * - "One moment": spoken once per turn when the model starts a tool call or
 *   when no sentence is ready after `fillerAfterMs`, and only if nothing
 *   was spoken yet in the turn.
 * - Handover (D11, explicit triggers): the model's `request_handover` tool
 *   for a person, a complaint, negotiation or an account question; code for
 *   a guardrail block, an unavailable model, a budget or tool-loop limit.
 * - Barge-in: the orchestrator aborts the signal; nothing more is emitted.
 *
 * Customer speech is untrusted data (D16): it is sanitised and wrapped.
 */
import { budgetHandoverReason } from '../core/agent/agent-turn.js';
import type { DisplayPolicy } from '../core/agent/display-gate.js';
import type { FactStore } from '../core/agent/facts.js';
import {
  regenerationMessage,
  responseSystemPrompt,
  sanitize,
} from '../core/agent/prompts.js';
import type { ToolOutcome } from '../core/agent/tools.js';
import { BudgetExhaustedError, type TurnBudget } from '../core/llm/budget.js';
import {
  isLlmError,
  type LlmMessage,
  type LlmStreamListener,
  type LlmToolDefinition,
  type ToolGenerationRequest,
  type ToolGenerationResult,
} from '../core/llm/llm-provider.js';
import type {
  HandoverReason,
  LocaleId,
  LocalePack,
} from '../core/locales/locale-pack.js';
import type { DomainPack } from '@agentcore/shared';
import { AsyncQueue } from './async-queue.js';
import { SentenceSplitter } from './call-orchestrator.js';
import type {
  Clock,
  ResponderEvent,
  TurnInput,
  TurnResponder,
} from './ports.js';
import {
  checkSpokenSentence,
  type SpokenCheckResult,
  type SpokenViolation,
} from './spoken-guardrail.js';

export const REQUEST_HANDOVER = 'request_handover';

/** Reasons the model may give; every other handover is decided by code. */
const MODEL_HANDOVER_REASONS = [
  'CUSTOMER_REQUEST',
  'COMPLAINT',
  'NEGOTIATION',
  'AUTH_REQUIRED',
] as const satisfies readonly HandoverReason[];

export const REQUEST_HANDOVER_TOOL: LlmToolDefinition = {
  name: REQUEST_HANDOVER,
  description:
    'Hand the call to a human operator. Only when the caller explicitly asks for a person or operator, complains about the business, asks for a discount or special terms, or asks about their own account or payments. Never for greetings or ordinary questions about courses, prices, dates or places.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', enum: [...MODEL_HANDOVER_REASONS] },
    },
    required: ['reason'],
    additionalProperties: false,
  },
};

/** The voice rules added to the standard reply rules. */
export function voiceSystemPrompt(
  pack: DomainPack,
  locale: LocalePack,
): string {
  return [
    responseSystemPrompt(pack, locale),
    'Voice call rules (they override the text rules above where they differ):',
    '- This is a phone call: answer in one or two short spoken sentences. Never use lists, numbering ("1."), bullet points, symbols or emoji.',
    '- Never say numbers, dates, times, prices, phone numbers, addresses, links or social-media names yourself, not even spelled out in words; only fact references from tool results such as {{F3}}. If the caller needs something no tool gives, say that an operator will confirm it.',
    `- Call ${REQUEST_HANDOVER} (and say nothing else) only when the caller explicitly asks for a person or operator, complains about the business, asks for a discount or special terms, or asks about their own account or payments. A greeting or an ordinary question about courses, prices, dates or places is never a reason: answer it, calling a search tool first when a fact is needed.`,
  ].join('\n');
}

/** The streaming LLM of one turn (MeteredLlm satisfies it). */
export interface VoiceTurnLlm {
  readonly budget: TurnBudget;
  streamWithTools(
    request: ToolGenerationRequest,
    onEvent: LlmStreamListener,
  ): Promise<ToolGenerationResult>;
}

/** The tools of one turn (AgentTools satisfies it). */
export interface VoiceTurnTools {
  definitions(): LlmToolDefinition[];
  run(name: string, input: unknown): Promise<ToolOutcome>;
}

/** Per-turn resources: a fresh budget, metered LLM, tools and fact store. */
export interface VoiceTurnResources {
  readonly llm: VoiceTurnLlm;
  readonly tools?: VoiceTurnTools;
  readonly facts: FactStore;
}

export interface VoiceTurnEngineOptions {
  readonly pack: DomainPack;
  readonly locales: { get(id: LocaleId): LocalePack };
  readonly timeZone: string;
  readonly scope: {
    readonly tenantId: string;
    readonly conversationId: string;
  };
  /**
   * Display policy from the tenant's connector capabilities (ADR 013), as in
   * a text turn: a connector that can quote live must have prices shown from
   * `get_quote`. Required, so a voice turn never runs with a weaker policy
   * by default.
   */
  readonly displayPolicy: DisplayPolicy;
  readonly beginTurn: (input: TurnInput) => VoiceTurnResources;
  readonly clock: Clock;
  readonly now?: () => Date;
  /** Filler when no sentence is ready this long after the turn starts. */
  readonly fillerAfterMs?: number;
  readonly maxOutputTokens?: number;
  /** Earlier turns of this call kept as context. */
  readonly historyTurns?: number;
  /**
   * Observability: a blocked sentence (its violation codes; the model's
   * sentence is included for debugging, never the caller's speech) and the
   * error code behind an LLM_UNAVAILABLE handover.
   */
  readonly onDiagnostic?: (event: VoiceTurnDiagnostic) => void;
}

export type VoiceTurnDiagnostic =
  | {
      readonly kind: 'blocked';
      readonly violations: readonly SpokenViolation[];
      readonly sentence: string;
    }
  | { readonly kind: 'llm_error'; readonly code: string };

type Emit = (event: ResponderEvent) => void;

function wrap(transcript: string): string {
  return `<caller_said>${sanitize(transcript)}</caller_said>`;
}

/** One engine per call: it keeps the call's history and caller texts. */
export class VoiceTurnEngine implements TurnResponder {
  private readonly history: LlmMessage[] = [];
  private readonly callerTexts: string[] = [];

  constructor(private readonly options: VoiceTurnEngineOptions) {}

  async *respond(
    input: TurnInput,
    signal: AbortSignal,
  ): AsyncIterable<ResponderEvent> {
    const queue = new AsyncQueue<ResponderEvent | null>();
    const run = this.runTurn(input, signal, (event) => {
      if (!signal.aborted) queue.push(event);
    })
      .catch(() => {
        if (!signal.aborted)
          queue.push({ type: 'handover', reason: 'LLM_UNAVAILABLE' });
      })
      .finally(() => queue.push(null));
    for (;;) {
      const event = await queue.next();
      if (event === null) break;
      // Events queued before a barge-in are dropped, never spoken.
      if (!signal.aborted) yield event;
    }
    await run;
  }

  private async runTurn(
    input: TurnInput,
    signal: AbortSignal,
    emit: Emit,
  ): Promise<void> {
    const { options } = this;
    const locale = options.locales.get(input.locale);
    const now = options.now ?? ((): Date => new Date());
    const system = voiceSystemPrompt(options.pack, locale);
    const { llm, tools, facts } = options.beginTurn(input);
    this.callerTexts.push(input.transcript);
    const user: LlmMessage = { role: 'user', text: wrap(input.transcript) };
    const messages: LlmMessage[] = [...this.history, user];
    const definitions = [
      ...(tools?.definitions() ?? []),
      REQUEST_HANDOVER_TOOL,
    ];
    const spoken: string[] = [];
    let fillerSpoken = false;
    let finished = false;

    const filler = (): void => {
      if (finished || fillerSpoken || spoken.length > 0 || signal.aborted)
        return;
      fillerSpoken = true;
      emit({ type: 'filler', text: locale.templates.voice.oneMoment });
    };
    void options.clock
      .sleep(options.fillerAfterMs ?? 900)
      .then(filler, () => undefined);

    const check = (sentence: string): SpokenCheckResult =>
      checkSpokenSentence(sentence, {
        facts,
        locale,
        customerTexts: this.callerTexts,
        timeZone: options.timeZone,
        now: now(),
        evidence: {
          tenantId: options.scope.tenantId,
          conversationId: options.scope.conversationId,
          policy: options.displayPolicy,
        },
        systemPrompt: system,
      });

    const handover = (reason: HandoverReason): void => {
      finished = true;
      emit({ type: 'handover', reason });
    };

    let regenerated = false;
    try {
      for (;;) {
        const round = new AbortController();
        const roundSignal = AbortSignal.any([signal, round.signal]);
        const splitter = new SentenceSplitter();
        let blocked: readonly SpokenViolation[] | undefined;
        const speak = (sentence: string): void => {
          if (blocked || signal.aborted) return;
          const result = check(sentence);
          if (result.rendered === undefined) {
            blocked = result.violations;
            options.onDiagnostic?.({
              kind: 'blocked',
              violations: result.violations,
              sentence,
            });
            round.abort();
            return;
          }
          spoken.push(result.rendered);
          emit({ type: 'sentence', text: result.rendered });
        };
        let result: ToolGenerationResult | undefined;
        try {
          result = await llm.streamWithTools(
            {
              tier: 'FAST',
              purpose: 'respond',
              system,
              messages,
              tools: definitions,
              maxOutputTokens: options.maxOutputTokens ?? 300,
              signal: roundSignal,
            },
            (event) => {
              if (event.type === 'tool_call_started') {
                if (event.name !== REQUEST_HANDOVER) filler();
                return;
              }
              for (const sentence of splitter.push(event.delta))
                speak(sentence);
            },
          );
        } catch (error: unknown) {
          if (signal.aborted) return;
          if (!blocked) throw error;
        }
        if (signal.aborted) return;
        // The tail of a reply cut off by the token limit, or refused, is
        // never spoken: it would end mid-word.
        if (
          !blocked &&
          result &&
          result.stopReason !== 'max_tokens' &&
          result.stopReason !== 'refusal'
        ) {
          const rest = splitter.flush();
          if (rest) speak(rest);
        }
        if (blocked) {
          if (!regenerated) {
            // One rewrite per turn. After a partial answer the model sees
            // what was already said and continues without repeating it.
            regenerated = true;
            if (spoken.length > 0)
              messages.push({
                role: 'assistant',
                text: spoken.join(' '),
                toolCalls: [],
              });
            messages.push({
              role: 'user',
              text:
                regenerationMessage(blocked, locale) +
                (spoken.length > 0
                  ? ' Continue after what you already said; do not repeat it.'
                  : ''),
            });
            continue;
          }
          return handover('GUARDRAIL');
        }
        if (!result) return handover('LLM_UNAVAILABLE');
        if (
          result.stopReason === 'refusal' ||
          result.stopReason === 'max_tokens'
        )
          return handover('GUARDRAIL');

        const handoverCall = result.toolCalls.find(
          (call) => call.name === REQUEST_HANDOVER,
        );
        if (handoverCall) {
          const reason = (handoverCall.input as { reason?: unknown } | null)
            ?.reason;
          return handover(
            MODEL_HANDOVER_REASONS.find((r) => r === reason) ??
              'CUSTOMER_REQUEST',
          );
        }
        if (result.toolCalls.length === 0) {
          if (spoken.length === 0) return handover('NO_DATA');
          return;
        }
        // Tool round: results go back to the model as untrusted data.
        llm.budget.beginToolRound();
        messages.push({
          role: 'assistant',
          text: result.text,
          toolCalls: result.toolCalls,
          providerContent: result.providerContent,
        });
        const results = [];
        for (const call of result.toolCalls) {
          const outcome = tools
            ? await tools.run(call.name, call.input)
            : undefined;
          results.push({
            toolCallId: call.id,
            content: outcome?.summary ?? 'Tool not available.',
            isError: !outcome?.ok,
          });
        }
        if (signal.aborted) return;
        messages.push({ role: 'tool_results', results });
      }
    } catch (error: unknown) {
      if (signal.aborted) return;
      if (error instanceof BudgetExhaustedError)
        return handover(budgetHandoverReason(error.reason));
      if (isLlmError(error)) {
        options.onDiagnostic?.({ kind: 'llm_error', code: error.code });
        return handover('LLM_UNAVAILABLE');
      }
      throw error;
    } finally {
      finished = true;
      // What the caller heard is context for the next turn, however the
      // turn ended (an answer, a handover or a barge-in).
      if (spoken.length > 0) this.remember(user, spoken.join(' '));
    }
  }

  /** Keeps what was actually said, bounded to the last turns of the call. */
  private remember(user: LlmMessage, said: string): void {
    this.history.push(user, { role: 'assistant', text: said, toolCalls: [] });
    const keep = (this.options.historyTurns ?? 4) * 2;
    if (this.history.length > keep)
      this.history.splice(0, this.history.length - keep);
  }
}
