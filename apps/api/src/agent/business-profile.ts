import { z } from 'zod';
import type { BusinessProfile } from '../core/agent/facts.js';

const Stored = z
  .object({
    address: z.string(),
    phone: z.string(),
    hours: z.string(),
    website: z.string(),
  })
  .partial();

/**
 * Owner 2026-11-23: the business's own details the bot may state, from the
 * tenant name and `config.profile`. Only fields with text are offered.
 */
export function businessProfileOf(tenant: {
  readonly name: string;
  readonly config: unknown;
}): BusinessProfile {
  const config = tenant.config as { profile?: unknown } | null;
  const stored = Stored.safeParse(config?.profile ?? {});
  const fields = stored.success ? stored.data : {};
  return Object.fromEntries(
    Object.entries({ name: tenant.name, ...fields }).filter(
      ([, value]) => typeof value === 'string' && value.trim() !== '',
    ),
  );
}

/** Owner 2026-11-24: at most this many rules, each at most this long. */
export const MAX_OWNER_RULES = 10;
export const MAX_OWNER_RULE_LENGTH = 300;

/** The owner's own instructions from `config.agentRules` (Rules tab). */
export function ownerRulesOf(tenant: { readonly config: unknown }): string[] {
  const config = tenant.config as { agentRules?: unknown } | null;
  const rules = Array.isArray(config?.agentRules) ? config.agentRules : [];
  return rules
    .filter((rule): rule is string => typeof rule === 'string')
    .map((rule) =>
      rule.replace(/\s+/gu, ' ').trim().slice(0, MAX_OWNER_RULE_LENGTH),
    )
    .filter(Boolean)
    .slice(0, MAX_OWNER_RULES);
}
