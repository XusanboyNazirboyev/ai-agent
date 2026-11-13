import { DomainPackSchema, type DomainPack } from '@agentcore/shared';
import { EDUCATION_PACK } from '../../packs/education/education.pack.js';

/**
 * Test-only knowledge-only pack (ADR 060): it lists knowledge_search and no
 * catalog tool, and has no search slot. It reuses the fictional education
 * pack's wording; it is never registered and lives outside `packs/`.
 */
export const KNOWLEDGE_ONLY_PACK: DomainPack = DomainPackSchema.parse({
  ...EDUCATION_PACK,
  key: 'knowledge-only-fixture',
  tools: ['knowledge_search'],
  slots: EDUCATION_PACK.slots.map((slot) => ({
    ...slot,
    requiredFor: slot.requiredFor.filter((purpose) => purpose !== 'search'),
  })),
});
