import type { DomainPack } from '@agentcore/shared';
import { EDUCATION_PACK } from './education/education.pack.js';
import { GENERAL_PACK } from './general/general.pack.js';
import { TRAVEL_PACK } from './travel/travel.pack.js';

/**
 * Registered Domain Packs by `key@version` (tenants select one). Onboarding a
 * new domain adds its pack here and under `src/packs/<domain>/`; nothing in
 * `src/core/**` changes (Phase 7 universality criterion).
 */
export const DOMAIN_PACKS: ReadonlyMap<string, DomainPack> = new Map(
  [EDUCATION_PACK, TRAVEL_PACK, GENERAL_PACK].map((pack) => [
    `${pack.key}@${pack.version}`,
    pack,
  ]),
);

/**
 * Business types a self-serve signup may pick (owner 2026-11-23): one per
 * registered pack key. Anything else is not offered until a pack fits it.
 */
export const SIGNUP_PACK_KEYS: readonly string[] = [
  ...new Set([...DOMAIN_PACKS.values()].map((pack) => pack.key)),
];

/** The newest registered pack with this key (versions sort as strings). */
export function packByKey(key: string): DomainPack | undefined {
  return [...DOMAIN_PACKS.values()]
    .filter((pack) => pack.key === key)
    .sort((a, b) => b.version.localeCompare(a.version))[0];
}
