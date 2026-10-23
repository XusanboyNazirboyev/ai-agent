import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CrmConnector } from '../../connectors/interfaces/crm-connector.js';
import type { LlmProvider } from '../../core/llm/llm-provider.js';
import { LlmError } from '../../core/llm/llm-provider.js';
import {
  ScriptedLlmProvider,
  type ScriptStep,
} from '../../core/llm/scripted-llm-provider.js';
import { usdToNano } from '../../core/llm/pricing.js';
import type { LocaleId } from '../../core/locales/locale-pack.js';
import type { AgentTurnResult } from '../../core/agent/agent-turn.js';
import { renderFactValue } from '../../core/agent/facts.js';
import {
  educationConnector,
  extraction,
  LOCALES as LOCALE_REGISTRY,
  runTurn,
  type TurnRun,
} from './agent-harness.js';

/**
 * Agent evaluation runner (AGENTS.md §12). Each case has scripted model
 * outputs for deterministic CI and model-independent expectations that a
 * live provider run can also be scored on. Scripted runs test the agent's
 * control logic; only live runs say anything about model quality.
 */

const LOCALES = ['uz-Latn', 'uz-Cyrl', 'ru', 'en'] as const;

const StepSchema = z.union([
  z
    .object({
      kind: z.literal('extract'),
      slots: z.record(z.string(), z.string().nullable()).default({}),
      intent: z.string().default('search'),
      language: z.string().default('uz'),
      script: z.string().default('Latn'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('extract_failure'),
      failure: z.enum(['refusal', 'truncated', 'malformed']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('respond'),
      text: z.string().optional(),
      toolCalls: z
        .array(z.object({ name: z.string(), input: z.unknown() }).strict())
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal('provider_error') }).strict(),
]);

export const EvalCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    pack: z.literal('education'),
    locale: z.enum(LOCALES),
    category: z.string().min(1),
    description: z.string().min(1),
    input: z
      .object({
        text: z.string(),
        conversationLocale: z.enum(LOCALES).optional(),
        slots: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .default({}),
      })
      .strict(),
    connector: z
      .enum(['default', 'none', 'down', 'no-quote', 'slow-offers'])
      .default('default'),
    turnBudgetUsd: z.string().optional(),
    repeatLastStep: z.boolean().default(false),
    scripted: z.array(StepSchema),
    expect: z
      .object({
        outcome: z
          .enum([
            'ASKED_SLOT',
            'ANSWERED',
            'NO_RESULTS',
            'HANDOVER',
            'FALLBACK',
          ])
          .optional(),
        locale: z.enum(LOCALES).optional(),
        askedSlot: z.string().optional(),
        handover: z.string().nullable().optional(),
        intent: z.string().optional(),
        slots: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional(),
        replyIncludes: z.array(z.string()).default([]),
        replyExcludes: z.array(z.string()).default([]),
        replyScript: z.enum(['Latn', 'Cyrl']).optional(),
        toolsOk: z.array(z.string()).optional(),
        toolErrors: z.array(z.string()).optional(),
        budgetStop: z.string().optional(),
        noInventedFacts: z.boolean().default(true),
      })
      .strict(),
    /** Expectations that also apply to a live model run. */
    live: z.boolean().default(true),
  })
  .strict();

export type EvalCase = z.infer<typeof EvalCaseSchema>;

export function loadCases(root: string): EvalCase[] {
  const cases: EvalCase[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.json')) {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        for (const entry of Array.isArray(raw) ? raw : [raw])
          cases.push(EvalCaseSchema.parse(entry));
      }
    }
  };
  walk(root);
  const ids = new Set<string>();
  for (const evalCase of cases) {
    if (ids.has(evalCase.id))
      throw new Error(`Duplicate eval case ${evalCase.id}`);
    ids.add(evalCase.id);
  }
  return cases;
}

function toStep(step: z.infer<typeof StepSchema>): ScriptStep {
  switch (step.kind) {
    case 'extract':
      return extraction(step.slots, step.intent, step.language, step.script);
    case 'extract_failure':
      return { kind: 'structured', failure: step.failure };
    case 'respond':
      return { kind: 'tools', text: step.text, toolCalls: step.toolCalls };
    case 'provider_error':
      return {
        kind: 'error',
        error: new LlmError('LLM_UNAVAILABLE', 'scripted outage', true),
      };
  }
}

export function scriptedProvider(evalCase: EvalCase): ScriptedLlmProvider {
  const steps = evalCase.scripted.map(toStep);
  if (!evalCase.repeatLastStep) return new ScriptedLlmProvider(steps);
  let index = 0;
  return new ScriptedLlmProvider(
    () => steps[Math.min(index++, steps.length - 1)],
  );
}

function connectorFor(kind: EvalCase['connector']): CrmConnector | null {
  const base = educationConnector();
  switch (kind) {
    case 'default':
      return base;
    case 'none':
      return null;
    case 'down':
      return educationConnector({ failureMode: 'transient' });
    case 'no-quote':
      return {
        connectorKey: base.connectorKey,
        context: base.context,
        sourceSystem: base.sourceSystem,
        capabilities: { ...base.capabilities, liveQuote: false },
        searchItems: (query) => base.searchItems(query),
        getOffers: (id) => base.getOffers(id),
      };
    case 'slow-offers':
      return {
        connectorKey: base.connectorKey,
        context: base.context,
        sourceSystem: base.sourceSystem,
        capabilities: base.capabilities,
        searchItems: (query) => base.searchItems(query),
        getOffers: () => new Promise(() => undefined),
      };
  }
}

/**
 * Digits in the reply must come from a fact's exact rendering or from the
 * customer's own message; anything else is an invented fact.
 */
export function inventedFacts(
  result: AgentTurnResult,
  customerText: string,
): string[] {
  const digits = withoutFacts(result).match(/\d+/gu) ?? [];
  return digits.filter((value) => !customerText.includes(value));
}

/** The reply minus every fact rendering: the text the agent wrote itself. */
function withoutFacts(result: AgentTurnResult): string {
  const locale = LOCALE_REGISTRY.get(result.locale);
  let text = result.reply;
  const rendered = result.facts
    .map((fact) => renderFactValue(fact.value, locale, 'Asia/Tashkent'))
    .sort((a, b) => b.length - a.length);
  for (const value of rendered) text = text.split(value).join(' ');
  return text;
}

export interface EvalOutcome {
  readonly id: string;
  readonly category: string;
  readonly locale: LocaleId;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly providerCalls: number;
  readonly costNano: number;
}

export function scoreCase(
  evalCase: EvalCase,
  run: TurnRun,
  mode: 'scripted' | 'live',
): EvalOutcome {
  const { result } = run;
  const e = evalCase.expect;
  const failures: string[] = [];
  const check = (ok: boolean, message: string): void => {
    if (!ok) failures.push(message);
  };
  if (e.outcome)
    check(
      result.outcome === e.outcome,
      `outcome ${result.outcome} != ${e.outcome}`,
    );
  if (e.locale)
    check(result.locale === e.locale, `locale ${result.locale} != ${e.locale}`);
  if (e.askedSlot)
    check(
      result.askedSlot === e.askedSlot,
      `askedSlot ${result.askedSlot} != ${e.askedSlot}`,
    );
  if (e.handover !== undefined) {
    check(
      (result.handover ?? null) === e.handover,
      `handover ${result.handover} != ${e.handover}`,
    );
  }
  if (e.intent)
    check(result.intent === e.intent, `intent ${result.intent} != ${e.intent}`);
  for (const [key, value] of Object.entries(e.slots ?? {})) {
    check(
      result.slots[key]?.value === value,
      `slot ${key}=${String(result.slots[key]?.value)} != ${value}`,
    );
  }
  if (e.replyScript) {
    // Product names come from the catalog in their own script; judge only
    // the text the agent wrote.
    const own = withoutFacts(result);
    const latin = own.match(/[a-z]/giu)?.length ?? 0;
    const cyr = own.match(/[\u0400-\u04ff]/gu)?.length ?? 0;
    check(
      e.replyScript === 'Cyrl' ? cyr > latin : latin > cyr,
      `reply script is not ${e.replyScript}`,
    );
  }
  if (mode === 'scripted') {
    for (const text of e.replyIncludes)
      check(result.reply.includes(text), `reply lacks "${text}"`);
    if (e.toolsOk) {
      const ok = result.tools
        .filter((t) => t.status === 'ok')
        .map((t) => t.name);
      check(
        JSON.stringify(ok) === JSON.stringify(e.toolsOk),
        `tools ${ok.join(',')} != ${e.toolsOk.join(',')}`,
      );
    }
    if (e.toolErrors) {
      const errors = result.tools
        .filter((t) => t.status === 'error')
        .map((t) => t.code);
      check(
        JSON.stringify(errors) === JSON.stringify(e.toolErrors),
        `tool errors ${errors.join(',')} != ${e.toolErrors.join(',')}`,
      );
    }
    if (e.budgetStop)
      check(
        result.budgetStop === e.budgetStop,
        `budgetStop ${result.budgetStop} != ${e.budgetStop}`,
      );
  }
  for (const text of e.replyExcludes)
    check(!result.reply.includes(text), `reply contains "${text}"`);
  if (e.noInventedFacts) {
    const invented = inventedFacts(result, evalCase.input.text);
    check(invented.length === 0, `unsourced digits: ${invented.join(' ')}`);
  }
  return {
    id: evalCase.id,
    category: evalCase.category,
    locale: evalCase.locale,
    passed: failures.length === 0,
    failures,
    providerCalls: run.usage.length,
    costNano: run.budget.snapshot.spentNano,
  };
}

export async function runCase(
  evalCase: EvalCase,
  provider: LlmProvider = scriptedProvider(evalCase),
  mode: 'scripted' | 'live' = 'scripted',
): Promise<EvalOutcome> {
  const slots = Object.fromEntries(
    Object.entries(evalCase.input.slots).map(([key, value]) => [
      key,
      { value, source: 'customer' as const },
    ]),
  );
  const run = await runTurn({
    provider,
    text: evalCase.input.text,
    connector: connectorFor(evalCase.connector),
    limits: evalCase.turnBudgetUsd
      ? { maxTurnCostNano: usdToNano(evalCase.turnBudgetUsd) }
      : {},
    input: { conversationLocale: evalCase.input.conversationLocale, slots },
  });
  return scoreCase(evalCase, run, mode);
}

export function summarize(outcomes: readonly EvalOutcome[]): {
  total: number;
  passed: number;
  byLocale: Record<string, { total: number; passed: number }>;
  byCategory: Record<string, { total: number; passed: number }>;
  avgProviderCalls: number;
  totalCostNano: number;
} {
  const group = (
    key: (o: EvalOutcome) => string,
  ): Record<string, { total: number; passed: number }> => {
    const result: Record<string, { total: number; passed: number }> = {};
    for (const outcome of outcomes) {
      const bucket = (result[key(outcome)] ??= { total: 0, passed: 0 });
      bucket.total += 1;
      if (outcome.passed) bucket.passed += 1;
    }
    return result;
  };
  return {
    total: outcomes.length,
    passed: outcomes.filter((o) => o.passed).length,
    byLocale: group((o) => o.locale),
    byCategory: group((o) => o.category),
    avgProviderCalls:
      outcomes.reduce((sum, o) => sum + o.providerCalls, 0) /
      Math.max(1, outcomes.length),
    totalCostNano: outcomes.reduce((sum, o) => sum + o.costNano, 0),
  };
}
