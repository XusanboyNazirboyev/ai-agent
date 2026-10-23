import type { ConnectorCapabilities } from '../../connectors/interfaces/crm-connector.js';
import type { Fact, FactStore } from './facts.js';

/**
 * Display gate for commercial facts (Stage C, ADR 013).
 *
 * A fact reference in a draft is accepted only when the application can
 * verify the stored evidence behind it: the evidence exists in this turn's
 * FactStore (a model-written id proves nothing), belongs to the turn's
 * tenant and conversation, names the offer it describes, is unexpired with a
 * safety margin, is not older than the freshness window, and, when the
 * connector can check live, comes from that live check. The policy is data
 * (`DisplayPolicy`), not a prompt.
 */

export type EvidenceViolation =
  | 'UNKNOWN_FACT'
  | 'STALE_FACT'
  | 'FACT_PROVENANCE_MISSING'
  | 'FACT_SCOPE_MISMATCH'
  | 'FACT_NOT_LIVE';

export interface DisplayPolicy {
  /** Price facts must be a confirmed live quote. */
  readonly requireLivePrice: boolean;
  /** Availability and seat facts must come from a live check. */
  readonly requireLiveAvailability: boolean;
  /** Evidence must stay valid at least this long after the check. */
  readonly minRemainingValidityMs: number;
  /** Evidence older than this is not shown as current. */
  readonly maxEvidenceAgeMs: number;
}

export const DEFAULT_DISPLAY_POLICY: Omit<
  DisplayPolicy,
  'requireLivePrice' | 'requireLiveAvailability'
> = {
  minRemainingValidityMs: 10_000,
  maxEvidenceAgeMs: 5 * 60_000,
};

/**
 * The connector contract decides: a connector that can quote or check
 * availability live must have its prices and availability shown from those
 * live results; one that cannot may show unexpired listed data.
 */
export function displayPolicyFor(
  capabilities: Pick<ConnectorCapabilities, 'liveQuote' | 'availability'>,
  overrides: Partial<DisplayPolicy> = {},
): DisplayPolicy {
  return {
    ...DEFAULT_DISPLAY_POLICY,
    requireLivePrice: capabilities.liveQuote,
    requireLiveAvailability: capabilities.availability,
    ...overrides,
  };
}

export interface EvidenceContext {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly policy: DisplayPolicy;
  readonly now: Date;
}

const COMMERCIAL: ReadonlySet<Fact['value']['kind']> = new Set([
  'price',
  'seats',
  'availability',
  'datetime',
]);

/** Checks one referenced fact; returns the violations it causes. */
export function checkFactEvidence(
  fact: Fact,
  context: EvidenceContext,
): EvidenceViolation[] {
  const { provenance: p, value } = fact;
  const { policy } = context;
  const found = new Set<EvidenceViolation>();
  const commercial = COMMERCIAL.has(value.kind);

  // Binding: every fact must be tied to this tenant and conversation; a
  // commercial one must also name the offer it describes.
  if (p.tenantId === undefined || p.conversationId === undefined) {
    found.add('FACT_PROVENANCE_MISSING');
  } else if (
    p.tenantId !== context.tenantId ||
    p.conversationId !== context.conversationId
  ) {
    found.add('FACT_SCOPE_MISMATCH');
  }
  if (commercial && (p.offerId === undefined || p.offerId === ''))
    found.add('FACT_PROVENANCE_MISSING');

  const now = context.now.getTime();
  const retrieved = Date.parse(p.retrievedAt);
  if (
    Number.isNaN(retrieved) ||
    retrieved > now + 1_000 || // evidence from the future is not evidence
    now - retrieved > policy.maxEvidenceAgeMs
  ) {
    found.add('STALE_FACT');
  }
  if (p.validUntil !== undefined) {
    const until = Date.parse(p.validUntil);
    if (Number.isNaN(until) || until - now < policy.minRemainingValidityMs)
      found.add('STALE_FACT');
  }

  if (value.kind === 'price') {
    if (policy.requireLivePrice && !(p.live === true && value.confirmedQuote))
      found.add('FACT_NOT_LIVE');
  } else if (value.kind === 'availability' || value.kind === 'seats') {
    if (policy.requireLiveAvailability && p.live !== true)
      found.add('FACT_NOT_LIVE');
  }
  return [...found];
}

/** Checks every reference in a draft against the store. */
export function checkReferences(
  references: readonly string[],
  facts: FactStore,
  context: EvidenceContext,
): Set<EvidenceViolation> {
  const violations = new Set<EvidenceViolation>();
  for (const id of references) {
    const fact = facts.get(id);
    if (!fact) {
      violations.add('UNKNOWN_FACT');
      continue;
    }
    for (const violation of checkFactEvidence(fact, context))
      violations.add(violation);
  }
  return violations;
}
