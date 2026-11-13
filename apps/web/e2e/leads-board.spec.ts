import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixtures, newSession } from './helpers';

// Lead funnel (ADR 058): the pipeline stage is the only thing an operator sets
// on a card. Score and status are read-only AI attributes. A viewer only looks.

async function resetLead(
  page: Page,
  conversationId: string,
  newStageId: string | null,
): Promise<void> {
  // Restores the shared fixture lead: the stage it started in.
  await page.evaluate(
    async ({ id, stageId }) => {
      const csrf = /(?:^|; )ac_csrf=([^;]+)/u.exec(document.cookie)?.[1] ?? '';
      const call = (
        method: string,
        path: string,
        body: unknown,
      ): Promise<Response> =>
        fetch(path, {
          method,
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': decodeURIComponent(csrf),
          },
          body: JSON.stringify(body),
        });
      if (stageId) {
        const listed = (await (
          await fetch('/api/v1/leads?limit=50')
        ).json()) as {
          items: { id: string; conversation: { id: string } }[];
        };
        const lead = listed.items.find((item) => item.conversation.id === id);
        if (lead)
          await call('PATCH', `/api/v1/leads/${lead.id}/stage`, { stageId });
      }
    },
    { id: conversationId, stageId: newStageId },
  );
}

/** One lead card, found by its conversation link. */
const cardOf = (page: Page, conversationId: string): Locator =>
  page.getByTestId('lead-card').filter({
    has: page.locator(`a[href*="c=${conversationId}"]`),
  });

test('an operator moves a lead between funnel stages', async ({ browser }) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  const { id: conversationId } = f.a.conversations[0]!;
  let newStageId: string | null = null;
  try {
    await page.goto('/leads?view=funnel');
    const card = cardOf(page, conversationId);
    await expect(card).toBeVisible();
    await expect(card.getByTestId('lead-card-channel')).toHaveText('Telegram');

    // Score and status are not settable on the card anymore.
    await expect(card.getByTestId('lead-card-score')).toHaveCount(0);
    await expect(card.getByTestId('lead-card-status')).toHaveCount(0);

    newStageId = await card.getByTestId('lead-card-stage').inputValue();

    // Move to a different stage via the stage select.
    const options = card.getByTestId('lead-card-stage').locator('option');
    const values = await options.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLOptionElement).value),
    );
    const target = values.find((value) => value !== newStageId)!;
    await card.getByTestId('lead-card-stage').selectOption(target);
    await expect(card.getByTestId('lead-card-stage')).toHaveValue(target);
    const column = page.locator('[data-testid^="lead-column-"]', {
      has: cardOf(page, conversationId),
    });
    await expect(column).toHaveCount(1);
  } finally {
    await resetLead(page, conversationId, newStageId);
    await context.close();
  }
});

test('a viewer sees the funnel but cannot change a lead', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.viewer.email,
  );
  await page.goto('/leads?view=funnel');
  const card = cardOf(page, f.a.conversations[0]!.id);
  await expect(card).toBeVisible();
  await expect(card.getByTestId('lead-card-stage')).toHaveCount(0);
  await context.close();
});
