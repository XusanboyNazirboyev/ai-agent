import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { findOverflow, fixtures, newHandover, newSession } from './helpers';

// The offer cards under an assistant reply say what the customer was shown in
// words (name, price, seats, date), not as internal ids. The stored facts are
// injected into the real conversation response; the rest is the real inbox.

const prov = {
  tool: 'get_quote',
  sourceSystem: 'mock-education',
  sourceEntityId: 'ielts-group-weekday',
  retrievedAt: '2026-11-07T05:00:00Z',
};
const FACTS = [
  {
    id: 'F1',
    value: { kind: 'title', text: 'IELTS group, weekdays' },
    provenance: prov,
  },
  {
    id: 'F5',
    value: {
      kind: 'price',
      money: { amount: '1250000', currency: 'UZS' },
      confirmedQuote: true,
      pricingBasis: 'PER_PERSON',
    },
    provenance: prov,
  },
  {
    id: 'F6',
    value: { kind: 'availability', status: 'LIMITED' },
    provenance: prov,
  },
  { id: 'F7', value: { kind: 'seats', count: 2 }, provenance: prov },
  {
    id: 'F8',
    value: { kind: 'datetime', iso: '2026-11-07T10:00:00+05:00' },
    provenance: prov,
  },
];

test('an offer card reads as a name, a price and a few chips, with the ids folded away', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Offer ${Date.now()}`);
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  try {
    await page.route('**/api/v1/inbox/conversations/*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as {
        messages: { id: string }[];
        shownOffers: unknown[];
      };
      body.shownOffers = [
        {
          id: 'so-1',
          messageId: body.messages[0]!.id,
          offerRef: 'mock-education:offer:ielts-group-weekday',
          facts: FACTS,
          shownAt: '2026-11-07T05:00:00Z',
        },
      ];
      return route.fulfill({ response, json: body });
    });
    await page
      .getByTestId('conversation-item')
      .filter({ hasText: handover.contactName })
      .click();
    const card = page.getByTestId('shown-offer');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('shown-offer-title')).toHaveText(
      'IELTS group, weekdays',
    );
    await expect(page.getByTestId('shown-offer-price')).toContainText(
      '1 250 000',
    );
    await expect(page.getByTestId('shown-offer-price')).toContainText('UZS');
    await expect(page.getByTestId('shown-offer-price')).toContainText(
      'per person',
    );
    await expect(card).toContainText('Price confirmed');
    await expect(card).toContainText('Few left');
    await expect(card).toContainText('2 seats left');
    // The internal references are not on the card until the fold is opened.
    await expect(card.getByText('F5', { exact: false })).toBeHidden();
    await card.getByText('Technical details').click();
    await expect(card).toContainText(
      'mock-education:offer:ielts-group-weekday',
    );
    await expect(card).toContainText('F5');

    expect(await findOverflow(page)).toEqual([]);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
      .analyze();
    expect(
      result.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`),
    ).toEqual([]);
  } finally {
    await context.close();
  }
});
