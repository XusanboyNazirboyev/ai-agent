import { expect, test } from '@playwright/test';
import { findOverflow, fixtures, newSession } from './helpers';

// Tasks on a lead (P1.6, ADR 068).

test('an operator adds a task to a lead, sees it on Today, and finishes it', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email, {
    viewport: { width: 1280, height: 800 },
  });
  const title = `Call back ${Date.now()}`;
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    await page.goto('/leads');
    await page.getByTestId('lead-card-open').first().click();
    const panel = page.getByTestId('lead-tasks');
    await panel.getByTestId('task-title').fill(title);
    // Due one hour ago: overdue, and on today's list.
    const at = new Date(Date.now() - 3_600_000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    await panel
      .getByTestId('task-due')
      .fill(
        `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`,
      );
    await panel.getByTestId('task-add').click();
    const row = panel.getByTestId('task').filter({ hasText: title });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Overdue');
    // The lead's history (P1.7) shows the new task with who added it.
    const history = page.getByTestId('lead-timeline');
    await history.locator('summary').click();
    await expect(
      history
        .getByTestId('timeline-entry')
        .filter({ hasText: `Task added: ${title}` }),
    ).toBeVisible();
    expect(await findOverflow(page)).toEqual([]);

    await page.goto('/today');
    const today = page.getByTestId('today-tasks');
    await expect(
      today.getByTestId('task').filter({ hasText: title }),
    ).toBeVisible();
    await today.getByRole('checkbox', { name: `Done: ${title}` }).click();
    // A finished task leaves the list (it is no longer open).
    await expect(
      today.getByTestId('task').filter({ hasText: title }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});
