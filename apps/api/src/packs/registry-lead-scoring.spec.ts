import { describe, expect, it } from 'vitest';
import { DOMAIN_PACKS } from './registry.js';

describe('pack registry', () => {
  // Owner 2026-11-17: every customer who writes is a lead. LeadService creates
  // no lead for a pack without scoring, so a new pack must bring its rules.
  it('every pack scores leads', () => {
    const missing = [...DOMAIN_PACKS.entries()]
      .filter(([, pack]) => !pack.leadScoring)
      .map(([key]) => key);
    expect(missing).toEqual([]);
  });
});
