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
