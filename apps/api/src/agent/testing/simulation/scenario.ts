import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HANDOVER_REASONS } from '../../../core/locales/locale-pack.js';

/**
 * Simulation scenarios (ADR 026 §J, roadmap slice 1). A scenario describes a
 * customer (persona, goal, private facts, an opening and a scripted fallback
 * per language) and the expected outcome. The harness drives the real v1
 * pipeline with it; grading is deterministic first (`grader.ts`), the LLM
 * judge's criteria are recorded but never gate until it is calibrated.
 *
 * Stored as JSON (validated here), not YAML: the repository has no YAML
 * parser and the existing evaluation cases are JSON.
 */
export const SIM_LANGUAGES = ['uz-Latn', 'uz-Cyrl', 'ru', 'en'] as const;
export type SimLanguage = (typeof SIM_LANGUAGES)[number];
export const SIM_PACKS = ['education', 'travel', 'retail'] as const;
export type SimPack = (typeof SIM_PACKS)[number];

const localized = z.partialRecord(z.enum(SIM_LANGUAGES), z.string().min(1));

const ScriptStepSchema = z.union([
  z.object({ say: z.string().min(1).max(1_000) }).strict(),
  z.object({ wait: z.object({ hours: z.number().min(1).max(72) }) }).strict(),
]);
export type ScriptStep = z.infer<typeof ScriptStepSchema>;

/** What the customer is after; checked from database state, not wording. */
export const OUTCOMES = [
  'recommend', // an offer from `shownItems` (or any, if empty) was shown
  'alternatives', // nothing matched exactly; another offer was shown
  'lead', // a lead exists with the customer's phone, or an action succeeded
  'proposal_confirmed', // the customer confirmed an action proposal
  'proposal_declined', // the customer declined an action proposal
  'handover', // a handover with `handoverReason` was opened
  'answer', // answered without handover (e.g. a knowledge or price question)
  'follow_up', // a follow-up was sent after the customer went silent
] as const;

export const ScenarioSchema = z
  .object({
    id: z.string().regex(/^(edu|tour|retail)-\d{2}$/u),
    pack: z.enum(SIM_PACKS),
    title: z.string().min(3).max(120),
    category: z.string().min(3).max(40),
    languages: z.array(z.enum(SIM_LANGUAGES)).min(1),
    persona: z
      .object({
        style: z.enum(['brief', 'chatty', 'formal']),
        patience: z.enum(['low', 'normal', 'high']),
        typos: z.boolean(),
      })
      .strict(),
    /** The customer's goal, as the simulated customer understands it. */
    goal: localized,
    /** Facts only the customer knows (name, phone, preferences). */
    facts: localized,
    /** Deterministic customer turns; the LLM customer starts with step 1. */
    script: z.partialRecord(
      z.enum(SIM_LANGUAGES),
      z.array(ScriptStepSchema).min(1).max(10),
    ),
    setup: z
      .object({
        actionsEnabled: z.boolean().default(false),
        contact: z
          .object({ name: z.string().optional(), phone: z.string().optional() })
          .strict()
          .default({}),
        /** Capabilities v1 lacks; reported, never silently skipped. */
        requires: z.array(z.enum(['memory', 'retail_pack'])).default([]),
      })
      .strict()
      .default({ actionsEnabled: false, contact: {}, requires: [] }),
    maxTurns: z.number().int().min(1).max(12).default(8),
    expect: z
      .object({
        outcome: z.enum(OUTCOMES),
        handoverReason: z.enum(HANDOVER_REASONS).optional(),
        /** Source entity ids of acceptable items (empty = any). */
        shownItems: z.array(z.string()).default([]),
        /** Slot values that must hold at the end (null = must be cleared). */
        finalSlots: z
          .record(z.string(), z.union([z.string(), z.number(), z.null()]))
          .default({}),
        /** True when any handover is a failure for this scenario. */
        noHandover: z.boolean().default(false),
      })
      .strict(),
    /** Soft criteria for the LLM judge (recorded, not gating). */
    judge: z.array(z.string().min(5)).min(1).max(5),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    for (const language of scenario.languages)
      for (const field of ['goal', 'facts', 'script'] as const)
        if (!scenario[field][language])
          ctx.addIssue({
            code: 'custom',
            message: `${field} missing for ${language}`,
            path: [field, language],
          });
    if (
      scenario.expect.outcome === 'handover' &&
      !scenario.expect.handoverReason
    )
      ctx.addIssue({
        code: 'custom',
        message: 'handover outcome needs handoverReason',
        path: ['expect', 'handoverReason'],
      });
    if (scenario.expect.noHandover && scenario.expect.outcome === 'handover')
      ctx.addIssue({
        code: 'custom',
        message: 'noHandover contradicts a handover outcome',
        path: ['expect', 'noHandover'],
      });
  });
export type Scenario = z.infer<typeof ScenarioSchema>;

/** Loads `eval/scenarios/<pack>/*.json`; throws on any invalid file. */
export function loadScenarios(root: string): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const pack of SIM_PACKS) {
    const files = ((): string[] => {
      try {
        return readdirSync(join(root, pack)).filter((f) => f.endsWith('.json'));
      } catch {
        return [];
      }
    })();
    for (const file of files.sort()) {
      const parsed = ScenarioSchema.safeParse(
        JSON.parse(readFileSync(join(root, pack, file), 'utf8')),
      );
      if (!parsed.success)
        throw new Error(`${pack}/${file}: ${parsed.error.message}`);
      if (parsed.data.pack !== pack)
        throw new Error(`${pack}/${file}: pack mismatch`);
      scenarios.push(parsed.data);
    }
  }
  const ids = scenarios.map((s) => s.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new Error(`duplicate scenario id ${duplicate}`);
  return scenarios;
}
