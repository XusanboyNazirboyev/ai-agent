/** Public sales page helpers (ADR 080). Prices are shown, never computed. */

export interface PublicPlan {
  code: string;
  name: string;
  /** Minor units as a string (the API never sends a float). */
  priceMinor: string;
  currency: string;
  periodDays: number;
  limits: {
    monthlyNewLeads?: number;
    maxOperators?: number;
    maxChannelAccounts?: number;
  };
}

export interface PublicPlans {
  plans: PublicPlan[];
  contactUrl: string | null;
}

/** Link of a plan button: signup with the plan code. */
export function signupHref(code?: string): string {
  return code ? `/signup?plan=${encodeURIComponent(code)}` : '/signup';
}

/** Only an https link may become the contact button. */
export function safeContactUrl(
  api: string | null | undefined,
  env: string | undefined,
): string | null {
  for (const value of [api, env]) {
    if (!value) continue;
    try {
      if (new URL(value).protocol === 'https:') return value;
    } catch {
      /* not a link */
    }
  }
  return null;
}

/** Limit lines of a plan in display order, as message keys with values. */
export function planLimitLines(
  limits: PublicPlan['limits'],
): { key: string; count: number }[] {
  const out: { key: string; count: number }[] = [];
  if (limits.monthlyNewLeads !== undefined)
    out.push({ key: 'site.plans.leads', count: limits.monthlyNewLeads });
  if (limits.maxOperators !== undefined)
    out.push({ key: 'site.plans.operators', count: limits.maxOperators });
  if (limits.maxChannelAccounts !== undefined)
    out.push({ key: 'site.plans.channels', count: limits.maxChannelAccounts });
  return out;
}

/** Banner state for the new-leads limit: warns from 80 %, nothing is blocked. */
export function leadLimitNotice(
  info:
    { newLeadsThisMonth: number; monthlyNewLeads: number } | null | undefined,
): 'near' | 'reached' | null {
  if (!info || info.monthlyNewLeads <= 0) return null;
  if (info.newLeadsThisMonth >= info.monthlyNewLeads) return 'reached';
  return info.newLeadsThisMonth * 100 >= info.monthlyNewLeads * 80
    ? 'near'
    : null;
}
