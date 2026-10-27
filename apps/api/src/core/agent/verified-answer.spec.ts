import { describe, expect, it } from 'vitest';
import type { Fact } from './facts.js';
import { verifiedQuoteDraft } from './verified-answer.js';

const provenance = (live: boolean): Fact['provenance'] => ({
  tool: 't',
  connectorKey: 'c',
  sourceSystem: 's',
  sourceEntityId: 'e',
  retrievedAt: '2026-10-26T00:00:00Z',
  live,
});
const title = (id: string): Fact => ({
  id,
  value: { kind: 'title', text: 'T' },
  provenance: provenance(false),
});
const price = (id: string, confirmed: boolean, live: boolean): Fact => ({
  id,
  value: {
    kind: 'price',
    money: { amount: '1.00', currency: 'USD' },
    pricingBasis: 'PER_PERSON',
    confirmedQuote: confirmed,
  },
  provenance: provenance(live),
});

describe('verifiedQuoteDraft', () => {
  it('pairs exactly one title with exactly one live confirmed price', () => {
    expect(
      verifiedQuoteDraft([
        title('F1'),
        price('F2', false, false),
        price('F3', true, true),
      ]),
    ).toBe('{{F1}}: {{F3}}');
  });

  it('refuses anything ambiguous or unconfirmed', () => {
    expect(
      verifiedQuoteDraft([title('F1'), price('F2', false, false)]),
    ).toBeUndefined();
    expect(
      verifiedQuoteDraft([title('F1'), price('F2', true, false)]),
    ).toBeUndefined();
    expect(verifiedQuoteDraft([price('F2', true, true)])).toBeUndefined();
    expect(
      verifiedQuoteDraft([title('F1'), title('F2'), price('F3', true, true)]),
    ).toBeUndefined();
    expect(
      verifiedQuoteDraft([
        title('F1'),
        price('F2', true, true),
        price('F3', true, true),
      ]),
    ).toBeUndefined();
  });
});
