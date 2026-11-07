import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixtures, newSession } from './helpers';

// Lead funnel (ADR 039) keeps the operator controls of ADR 037: on each card
// an operator sets the score and the status, and moves the lead to another
// tenant-configured stage. A viewer only looks.

async function resetLead(
  page: Page,
  conversationId: string,
  newStageId: string | null,
): Promise<void> {
  // Restores the shared fixture lead: automatic score, status NEW and the
  // stage it started in.
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
      await call('PUT', `/api/v1/leads/conversations/${id}/score`, {
        score: 'HOT',
      });
      await call('PUT', `/api/v1/leads/conversations/${id}/score`, {
        score: null,
      });
      await call('PUT', `/api/v1/leads/conversations/${id}/status`, {
        status: 'NEW',
      });
      if (stageId) {
        const page = (await (await fetch('/api/v1/leads?limit=50')).json()) as {
          items: { id: string; conversation: { id: string } }[];
        };
        const lead = page.items.find((item) => item.conversation.id === id);
        if (lead)
          await call('PATCH', `/api/v1/leads/${lead.id}/stage`, { stageId });
      }
    },
    { id: conversationId, stageId: newStageId },
  );
}

const cardIn = (column: Locator, name: string): Locator =>
  column.getByTestId('lead-card').filter({ hasText: name });

test('an operator sets score and status and moves a lead between funnel stages', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  const { id: conversationId, contactName } = f.a.conversations[0]!;
  let newStageId: string | null = null;
  try {
    await page.goto('/leads?view=funnel');
    const card = cardIn(page.locator('body'), contactName);
    await expect(card).toBeVisible();
    newStageId = await card.getByTestId('lead-card-stage').inputValue();

    await card.getByTestId('lead-card-score').selectOption('WARM');
    await expect(card.getByTestId('lead-card-score')).toHaveValue('WARM');
    await card.getByTestId('lead-card-status').selectOption('WON');
    await expect(card.getByTestId('lead-card-status')).toHaveValue('WON');

    // Move to a stage other than the current one, by its funnel column.
    const options = card.getByTestId('lead-card-stage').locator('option');
    const values = await options.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLOptionElement).value),
    );
    const target = values.find((value) => value !== newStageId)!;
    await card.getByTestId('lead-card-stage').selectOption(target);
    await expect(card.getByTestId('lead-card-stage')).toHaveValue(target);
    const column = page.locator('[data-testid^="lead-column-"]', {
      has: page.getByTestId('lead-card').filter({ hasText: contactName }),
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
  const card = cardIn(page.locator('body'), f.a.conversations[0]!.contactName);
  await expect(card).toBeVisible();
  await expect(card.getByTestId('lead-card-stage')).toHaveCount(0);
  await expect(card.getByTestId('lead-card-score')).toHaveCount(0);
  await expect(card.getByTestId('lead-card-status')).toHaveCount(0);
  await context.close();
});
