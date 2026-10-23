import type { HandoverReason } from '../locales/locale-pack.js';

/**
 * Typed outcome of a deterministic safety gate (Stage C, ADR 013). Gates
 * decide; they never notify anyone. `escalation` is a recommendation for the
 * handover layer (Phase 5), and `operatorNotified` is always false here:
 * nothing in this layer can reach an operator, and no customer text may say
 * otherwise.
 */
export type SafetyStatus =
  'BLOCKED' | 'CLARIFICATION_REQUIRED' | 'ESCALATION_REQUIRED';

export type SafetyGate = 'LANGUAGE' | 'DISPLAY';

export interface SafetyOutcome {
  readonly status: SafetyStatus;
  readonly gate: SafetyGate;
  readonly reasonCodes: readonly string[];
  readonly escalation?: {
    readonly reason: HandoverReason;
    readonly operatorNotified: false;
  };
}
