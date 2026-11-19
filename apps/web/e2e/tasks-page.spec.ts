import { expect, test } from '@playwright/test';
import { findOverflow, fixtures, newSession } from './helpers';

// The Tasks page (ADR 068 amendment): create a task for a lead, finish it.

test('an operator creates a task on the Tasks page and finishes it', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email, {
    viewport: { width: 375, height: 800 },
  });
  const title = `Page task ${Date.now()}`;
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    await page.goto('/tasks');
    await page.getByTestId('task-new').click();
    const dialog = page.getByTestId('task-dialog');
    // The lead picker searches as you type; any seeded lead will do.
    await dialog.getByTestId('task-lead-search').fill('a');
    await dialog.getByTestId('task-lead-option').first().click();
    await dialog.getByTestId('task-form-title').fill(title);
    // One hour ago: overdue.
    const at = new Date(Date.now() - 3_600_000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    await dialog
      .getByTestId('task-form-due')
      .fill(
        `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`,
      );
    await dialog.getByTestId('task-save').click();
    await page.getByTestId('tasks-segment-overdue').click();
    const row = page.getByTestId('task-row').filter({ hasText: title });
    await expect(row).toBeVisible();
    expect(await findOverflow(page)).toEqual([]);
    await row.getByRole('checkbox').click();
    await expect(row).toHaveCount(0);
    await page.getByTestId('tasks-segment-done').click();
    await expect(
      page.getByTestId('task-row').filter({ hasText: title }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
