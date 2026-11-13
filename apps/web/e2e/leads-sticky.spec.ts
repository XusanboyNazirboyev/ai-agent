import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';

// A long column scrolls while its header (name, count, "+") stays in view.
// Tenant B: the leads added here stay out of the shared board of tenant A.

test('the column header stays visible while a long column scrolls', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.b.operators.op1.email, {
    viewport: { width: 1280, height: 600 },
  });
  await page.goto('/leads?view=funnel');
  await expect(page.getByTestId('lead-column-NEW')).toBeVisible();
  await page.evaluate(async () => {
    const csrf = /(?:^|; )ac_csrf=([^;]+)/u.exec(document.cookie)?.[1] ?? '';
    for (let i = 0; i < 14; i++)
      await fetch('/api/v1/leads', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': decodeURIComponent(csrf),
        },
        body: JSON.stringify({ name: `Sticky ${Date.now()}-${i}` }),
      });
  });
  await page.reload();
  const column = page.getByTestId('lead-column-NEW');
  // The fixture tenant may hold a lead of its own: at least the 14 added here.
  await expect
    .poll(() => column.getByTestId('lead-card').count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(14);

  // The board is bounded in height, so a long column really scrolls.
  const scroller = page.getByTestId('leads-board-scroller');
  const scrolls = await scroller.evaluate(
    (el) => el.scrollHeight > el.clientHeight + 20,
  );
  expect(scrolls).toBe(true);

  const header = column.locator('header');
  await expect(header).toBeInViewport();
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  // After scrolling to the bottom the last card is in view and so is the header.
  await expect(column.getByTestId('lead-card').last()).toBeInViewport();
  await expect(header).toBeInViewport();
  await expect(header.getByTestId('lead-column-add')).toBeInViewport();
  await context.close();
});
