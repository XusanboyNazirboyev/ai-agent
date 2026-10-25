/**
 * Evaluation coverage taxonomy (Phase 7.2, docs/PHASE7_PLAN.md). Every case
 * category maps to one risk group; the gate counts cases per pack, locale and
 * group across the scripted single-turn suite and the action-lifecycle suite.
 * An unmapped category is an error, so new cases cannot dodge the count.
 */
export const REQUIRED_GROUPS = [
  'normal_answer',
  'missing_data',
  'follow_up',
  'typos_mixed',
  'injection',
  'regulated_info',
  'handover',
  'action_confirm',
  'action_decline',
  'action_failure',
  'duplicate_request',
] as const;

/** Groups that must be present (≥ 1) for every pack and locale. */
export const BLOCKING_GROUPS = [
  'invented_facts',
  'tenant_isolation',
  'authorization',
] as const;

export const THRESHOLDS = {
  perPackLocale: 25,
  perPack: 100,
  perRequiredGroup: 3,
  perBlockingGroup: 1,
} as const;

const GROUP_OF: Readonly<Record<string, string>> = {
  multi_slot: 'normal_answer',
  price_live_quote: 'normal_answer',
  availability_answer: 'normal_answer',
  script_consistency: 'normal_answer',
  budget_slot: 'normal_answer',
  slot_correction: 'normal_answer',
  explicit_language_request: 'normal_answer',
  ai_disclosure: 'normal_answer',
  price_not_in_catalog: 'missing_data',
  empty_results: 'missing_data',
  unavailable_offer: 'missing_data',
  stale_offer: 'missing_data',
  listed_price_blocked: 'missing_data',
  unsupported_capability: 'missing_data',
  missing_slot: 'follow_up',
  short_ambiguous: 'follow_up',
  action_field_question: 'follow_up',
  typo: 'typos_mixed',
  mixed_script: 'typos_mixed',
  mixed_language: 'typos_mixed',
  apostrophe_variants: 'typos_mixed',
  prompt_injection: 'injection',
  customer_injection: 'injection',
  catalog_injection: 'injection',
  regulated_info: 'regulated_info',
  handover_request: 'handover',
  complaint: 'handover',
  handover_negotiation: 'handover',
  handover_auth: 'handover',
  account_specific: 'handover',
  action_confirm: 'action_confirm',
  action_decline: 'action_decline',
  action_failure: 'action_failure',
  duplicate_request: 'duplicate_request',
  invented_price: 'invented_facts',
  invented_price_regenerated: 'invented_facts',
  invented_claim: 'invented_facts',
  tenant_isolation: 'tenant_isolation',
  authorization: 'authorization',
  shadow_mode: 'authorization',
  budget_exhausted: 'safe_failure',
  connector_outage: 'safe_failure',
  provider_outage: 'safe_failure',
  tool_loop: 'safe_failure',
  tool_timeout: 'safe_failure',
  invalid_tool_args: 'safe_failure',
  language_low_confidence: 'safe_failure',
  language_repeated_unclear: 'safe_failure',
  language_unsupported_script: 'safe_failure',
  explicit_request_unreadable: 'safe_failure',
};

export function groupOf(category: string): string {
  const group = GROUP_OF[category];
  if (!group) throw new Error(`Eval category "${category}" has no risk group`);
  return group;
}

export interface CoverageCase {
  readonly pack: string;
  readonly locale: string;
  readonly category: string;
}

export interface CoverageReport {
  readonly counts: Record<string, Record<string, number>>; // "pack/locale" -> group -> n
  readonly totals: Record<string, number>; // "pack/locale" -> n
  readonly perPack: Record<string, number>;
  readonly gaps: string[];
}

/** Counts cases and lists every unmet threshold (empty = gate passes). */
export function coverage(
  cases: readonly CoverageCase[],
  packs: readonly string[],
  locales: readonly string[],
): CoverageReport {
  const counts: Record<string, Record<string, number>> = {};
  const totals: Record<string, number> = {};
  const perPack: Record<string, number> = {};
  for (const item of cases) {
    const key = `${item.pack}/${item.locale}`;
    const group = groupOf(item.category);
    (counts[key] ??= {})[group] = (counts[key][group] ?? 0) + 1;
    totals[key] = (totals[key] ?? 0) + 1;
    perPack[item.pack] = (perPack[item.pack] ?? 0) + 1;
  }
  const gaps: string[] = [];
  for (const pack of packs) {
    if ((perPack[pack] ?? 0) < THRESHOLDS.perPack)
      gaps.push(`${pack}: ${perPack[pack] ?? 0} cases < ${THRESHOLDS.perPack}`);
    for (const locale of locales) {
      const key = `${pack}/${locale}`;
      if ((totals[key] ?? 0) < THRESHOLDS.perPackLocale)
        gaps.push(
          `${key}: ${totals[key] ?? 0} cases < ${THRESHOLDS.perPackLocale}`,
        );
      for (const group of REQUIRED_GROUPS)
        if ((counts[key]?.[group] ?? 0) < THRESHOLDS.perRequiredGroup)
          gaps.push(
            `${key}/${group}: ${counts[key]?.[group] ?? 0} < ${THRESHOLDS.perRequiredGroup}`,
          );
      for (const group of BLOCKING_GROUPS)
        if ((counts[key]?.[group] ?? 0) < THRESHOLDS.perBlockingGroup)
          gaps.push(`${key}/${group}: missing`);
    }
  }
  return { counts, totals, perPack, gaps };
}
