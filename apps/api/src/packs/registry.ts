import type { DomainPack } from '@agentcore/shared';
import { EDUCATION_PACK } from './education/education.pack.js';
import { TRAVEL_PACK } from './travel/travel.pack.js';

/**
 * Registered Domain Packs by `key@version` (tenants select one). Onboarding a
 * new domain adds its pack here and under `src/packs/<domain>/`; nothing in
 * `src/core/**` changes (Phase 7 universality criterion).
 */
export const DOMAIN_PACKS: ReadonlyMap<string, DomainPack> = new Map(
  [EDUCATION_PACK, TRAVEL_PACK].map((pack) => [
    `${pack.key}@${pack.version}`,
    pack,
  ]),
);
