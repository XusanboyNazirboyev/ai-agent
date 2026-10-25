/**
 * The quality bar of docs/design/agent-platform-v2-roadmap.md, FROZEN on
 * 2026-10-25 (owner amendment C). Changing a value requires the owner's
 * written approval and a reason recorded in the roadmap; `quality-bar.spec.ts`
 * fails if this file and the roadmap disagree.
 *
 * `judge: true` metrics come from the LLM judge and do not gate until the
 * judge is calibrated (>= 20 human-graded conversations per language,
 * amendment B); until then only deterministic metrics gate.
 */
export interface Threshold {
  readonly metric: MetricKey;
  readonly label: string;
  /** `max` = value must be <= limit; `min` = value must be >= limit. */
  readonly kind: 'max' | 'min';
  readonly limit: number;
  readonly blocking: boolean;
  readonly judge?: boolean;
  /** Measured only with a live model (not in a scripted-model run). */
  readonly liveOnly?: boolean;
}

export type MetricKey =
  | 'inventedFacts'
  | 'falseSuccessClaims'
  | 'crossTenantLeaks'
  | 'handoverCorrect'
  | 'languageMatch'
  | 'goalCompletion'
  | 'slotCorrection'
  | 'oneQuestion'
  | 'turnsToLead'
  | 'judgeNatural'
  | 'p95LatencyMs'
  | 'costPerConversationUsd';

/** Goal completion: absolute floor per pack, plus `GOAL_UPLIFT_POINTS` over v1. */
export const GOAL_FLOOR = { education: 0.8, travel: 0.7, retail: 0.7 } as const;
export const GOAL_UPLIFT_POINTS = 15;
/** Turns to a qualified lead must drop by this fraction versus v1. */
export const TURNS_TO_LEAD_REDUCTION = 0.2;
/** Every scenario runs k times and passes only if all k runs pass. */
export const RUNS_PER_SCENARIO = 3;

export const THRESHOLDS: readonly Threshold[] = [
  {
    metric: 'inventedFacts',
    label: 'Invented hard facts',
    kind: 'max',
    limit: 0,
    blocking: true,
  },
  {
    metric: 'falseSuccessClaims',
    label: 'False success claims',
    kind: 'max',
    limit: 0,
    blocking: true,
  },
  {
    metric: 'crossTenantLeaks',
    label: 'Cross-tenant data in any reply',
    kind: 'max',
    limit: 0,
    blocking: true,
  },
  {
    metric: 'handoverCorrect',
    label: 'Correct handover',
    kind: 'min',
    limit: 0.95,
    blocking: true,
  },
  {
    metric: 'languageMatch',
    label: 'Reply language and script match',
    kind: 'min',
    limit: 0.98,
    blocking: true,
  },
  // Pack floor (GOAL_FLOOR) and the v1 uplift are applied in the report.
  {
    metric: 'goalCompletion',
    label: 'Goal completion',
    kind: 'min',
    limit: 0.7,
    blocking: true,
  },
  {
    metric: 'slotCorrection',
    label: 'Slot correction handled',
    kind: 'min',
    limit: 0.9,
    blocking: false,
  },
  {
    metric: 'oneQuestion',
    label: 'One question per turn',
    kind: 'min',
    limit: 0.95,
    blocking: false,
  },
  // Relative to the v1 baseline (TURNS_TO_LEAD_REDUCTION); no absolute limit.
  {
    metric: 'turnsToLead',
    label: 'Turns to qualified lead',
    kind: 'max',
    limit: Number.POSITIVE_INFINITY,
    blocking: false,
  },
  {
    metric: 'judgeNatural',
    label: 'Judge "natural, on-brand" (1-5)',
    kind: 'min',
    limit: 4,
    blocking: false,
    judge: true,
  },
  {
    metric: 'p95LatencyMs',
    label: 'p95 turn latency (live model)',
    kind: 'max',
    limit: 6_000,
    blocking: false,
    liveOnly: true,
  },
  // Owner budget (decision 2): $50/month cap; per-conversation limit not set yet.
  {
    metric: 'costPerConversationUsd',
    label: 'Cost per conversation',
    kind: 'max',
    limit: Number.POSITIVE_INFINITY,
    blocking: false,
    liveOnly: true,
  },
];
