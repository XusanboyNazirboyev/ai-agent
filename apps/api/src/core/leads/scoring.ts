import type { LeadScoring } from '@agentcore/shared';

/**
 * Deterministic lead scoring from the Domain Pack's rules (spec §8). The
 * result always carries the reason codes that produced it. No model is
 * involved: a structured classification may be added later through
 * MeteredLlm, but it could only add reasons, never override these rules.
 */
export type LeadLevel = 'HOT' | 'WARM' | 'COLD';

export interface LeadSignals {
  readonly slots: Readonly<Record<string, string | number>>;
  readonly intent?: string;
  readonly hasPhone: boolean;
  readonly offerShown: boolean;
  readonly quoteShown: boolean;
}

export interface LeadScoreResult {
  readonly level: LeadLevel;
  readonly points: number;
  readonly reasonCodes: readonly string[];
}

export function scoreLead(
  scoring: LeadScoring,
  signals: LeadSignals,
): LeadScoreResult {
  let points = 0;
  const reasonCodes: string[] = [];
  for (const rule of scoring.rules) {
    const { when } = rule;
    const matched =
      when.kind === 'slot_present'
        ? signals.slots[when.slot] !== undefined
        : when.kind === 'slot_equals'
          ? String(signals.slots[when.slot]) === when.value
          : when.kind === 'intent'
            ? signals.intent === when.intent
            : when.kind === 'contact_phone'
              ? signals.hasPhone
              : when.kind === 'offer_shown'
                ? signals.offerShown
                : signals.quoteShown;
    if (matched && !reasonCodes.includes(rule.code)) {
      points += rule.points;
      reasonCodes.push(rule.code);
    }
  }
  const level: LeadLevel =
    points >= scoring.hot ? 'HOT' : points >= scoring.warm ? 'WARM' : 'COLD';
  return { level, points, reasonCodes };
}
