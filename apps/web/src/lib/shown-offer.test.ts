import { describe, expect, it } from 'vitest';
import { describeShownOffer, groupAmount } from './shown-offer';

const prov = (
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  tool: 'get_quote',
  sourceSystem: 'mock-education',
  sourceEntityId: 'offer-1',
  retrievedAt: '2026-11-07T05:00:00Z',
  ...extra,
});

describe('describeShownOffer', () => {
  it('turns the stored facts into a title, price, availability, seats and date', () => {
    const view = describeShownOffer('mock-education:offer:x', [
      {
        id: 'F1',
        value: { kind: 'title', text: ' IELTS group ' },
        provenance: prov(),
      },
      {
        id: 'F2',
        value: {
          kind: 'price',
          money: { amount: '820', currency: 'USD' },
          confirmedQuote: false,
          pricingBasis: 'PER_PERSON',
        },
        provenance: prov(),
      },
      {
        id: 'F3',
        value: { kind: 'availability', status: 'LIMITED' },
        provenance: prov(),
      },
      { id: 'F4', value: { kind: 'seats', count: 2 }, provenance: prov() },
      {
        id: 'F5',
        value: { kind: 'datetime', iso: '2026-11-07T10:00:00+05:00' },
        provenance: prov({ retrievedAt: '2026-11-07T05:05:00Z' }),
      },
    ]);
    expect(view).toMatchObject({
      title: 'IELTS group',
      price: {
        amount: '820',
        currency: 'USD',
        basis: 'PER_PERSON',
        confirmed: false,
      },
      availability: 'LIMITED',
      seats: 2,
      startsAt: '2026-11-07T10:00:00+05:00',
      checkedAt: '2026-11-07T05:05:00Z',
    });
    // The ids stay available, but only for the details fold.
    expect(view.technical).toEqual([
      'mock-education:offer:x',
      'F1',
      'mock-education',
      'F2',
      'F3',
      'F4',
      'F5',
    ]);
  });

  it('prefers a confirmed quote over a listed price, whatever the order', () => {
    const listed = {
      id: 'F1',
      value: {
        kind: 'price',
        money: { amount: '900', currency: 'USD' },
        confirmedQuote: false,
      },
      provenance: prov(),
    };
    const confirmed = {
      id: 'F2',
      value: {
        kind: 'price',
        money: { amount: '820', currency: 'USD' },
        confirmedQuote: true,
      },
      provenance: prov(),
    };
    for (const facts of [
      [listed, confirmed],
      [confirmed, listed],
    ])
      expect(describeShownOffer('o', facts).price).toMatchObject({
        amount: '820',
        confirmed: true,
      });
  });

  it('survives data that is not what was expected', () => {
    for (const facts of [
      null,
      undefined,
      'x',
      5,
      {},
      [
        null,
        1,
        'a',
        [],
        { value: 'x' },
        { value: { kind: 'price', money: {} } },
        { value: { kind: 'seats', count: -1 } },
        { value: { kind: 'availability', status: 'MAYBE' } },
      ],
    ])
      expect(describeShownOffer('item:abc', facts)).toMatchObject({
        title: null,
        price: null,
        availability: null,
        seats: null,
        startsAt: null,
      });
  });

  it('keeps an unknown pricing basis out of the display', () => {
    expect(
      describeShownOffer('o', [
        {
          id: 'F1',
          value: {
            kind: 'price',
            money: { amount: '5', currency: 'UZS' },
            confirmedQuote: true,
            pricingBasis: 'UNSPECIFIED',
          },
          provenance: prov(),
        },
      ]).price?.basis,
    ).toBeNull();
  });
});

describe('groupAmount', () => {
  it('groups digits as text', () => {
    expect(groupAmount('820')).toBe('820');
    expect(groupAmount('1250000')).toBe('1 250 000');
    expect(groupAmount('1250000.50')).toBe('1 250 000.50');
    expect(groupAmount('9007199254740993')).toBe('9 007 199 254 740 993');
  });
});
