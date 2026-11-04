import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixtures, newSession } from './helpers';

// Lead board moves (ADR 037): a card moves to another score or status
// column by drag and drop or by its "Move to" menu.

async function resetLead(page: Page, conversationId: string): Promise<void> {
  // Restores the shared fixture lead: HOT, automatic score, status NEW.
  await page.evaluate(async (id) => {
    const csrf = /(?:^|; )ac_csrf=([^;]+)/u.exec(document.cookie)?.[1] ?? '';
    const put = (path: string, body: unknown): Promise<Response> =>
      fetch(`/api/v1/leads/conversations/${id}/${path}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': decodeURIComponent(csrf),
        },
        body: JSON.stringify(body),
      });
    await put('score', { score: 'HOT' });
    await put('score', { score: null });
    await put('status', { status: 'NEW' });
  }, conversationId);
}

test('an operator moves a lead between score and status columns by menu and by drag', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  const { id: conversationId, contactName } = f.a.conversations[0]!;
  try {
    await page.goto('/leads');
    const hot = page.getByTestId('lead-column-HOT');
    const warm = page.getByTestId('lead-column-WARM');
    const card = (column: Locator): Locator =>
      column.getByTestId('lead-card-item').filter({ hasText: contactName });
    await expect(card(hot)).toBeVisible();

    await card(hot).getByTestId('lead-move').selectOption('WARM');
    await expect(card(warm)).toBeVisible();
    await expect(card(hot)).toHaveCount(0);
    await expect(card(warm)).toContainText('set by an operator');

    await card(warm).dragTo(hot);
    await expect(card(hot)).toBeVisible();
    await expect(card(warm)).toHaveCount(0);

    await page.getByTestId('leads-mode-status').click();
    const fresh = page.getByTestId('lead-column-NEW');
    const won = page.getByTestId('lead-column-WON');
    await expect(card(fresh)).toBeVisible();
    await card(fresh).getByTestId('lead-move').selectOption('WON');
    await expect(card(won)).toBeVisible();
    await card(won).dragTo(fresh);
    await expect(card(fresh)).toBeVisible();
    await expect(card(won)).toHaveCount(0);
  } finally {
    await resetLead(page, conversationId);
    await context.close();
  }
});

test('a viewer sees the board but cannot move leads', async ({ browser }) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.viewer.email,
  );
  await page.goto('/leads');
  const card = page
    .getByTestId('lead-column-HOT')
    .getByTestId('lead-card-item')
    .filter({ hasText: f.a.conversations[0]!.contactName });
  await expect(card).toBeVisible();
  await expect(card.getByTestId('lead-move')).toHaveCount(0);
  await expect(card).toHaveAttribute('draggable', 'false');
  await context.close();
});
