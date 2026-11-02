import { expect, test } from '@playwright/test';
import { findOverflow, fixtures, newSession } from './helpers';

const daysBefore = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

test('an admin reads the Section 11 metrics and changes the period', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
  );
  await page.goto('/analytics');

  // The seeded conversations of tenant A are counted (other specs may add more).
  const total = page.getByTestId('analytics-conversations');
  await expect(total).toContainText(/\d/u);
  const count = Number(((await total.textContent()) ?? '').replace(/\D/gu, ''));
  expect(count).toBeGreaterThanOrEqual(f.a.conversations.length);
  for (const id of [
    'analytics-first-response',
    'analytics-auto-resolved',
    'analytics-handover',
    'analytics-lead-capture',
    'analytics-guardrail',
    'analytics-cost',
    'analytics-latency',
    'analytics-chart-conversations',
    'analytics-chart-handovers',
    'analytics-chart-reasons',
    'analytics-chart-languages',
    'analytics-chart-scores',
    'analytics-details',
  ])
    await expect(page.getByTestId(id)).toBeVisible();

  // The chart is labelled for screen readers and has the same data as a table.
  const chart = page.getByTestId('analytics-chart-conversations');
  await expect(chart.getByRole('img')).toHaveAttribute(
    'aria-label',
    /Conversations per day: .* in total/u,
  );
  await chart.getByText('Show as a table').click();
  await expect(chart.getByRole('table')).toBeVisible();
  // The default period is 30 days: one table row per day plus the header.
  await expect(chart.getByRole('row')).toHaveCount(31);

  const to = await page.getByTestId('analytics-to').inputValue();
  await page.getByTestId('analytics-preset-7').click();
  await expect(page.getByTestId('analytics-preset-7')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('analytics-from')).toHaveValue(
    daysBefore(to, 6),
  );
  await expect(chart.getByRole('row')).toHaveCount(8);
  expect(await findOverflow(page), 'analytics admin').toEqual([]);
  await context.close();
});

test('an operator sees that only owners and admins read analytics', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email, {
    viewport: { width: 320, height: 800 },
  });
  await page.goto('/analytics');
  await expect(page.getByTestId('analytics-admin-only')).toBeVisible();
  await expect(page.getByTestId('analytics-conversations')).toHaveCount(0);
  expect(await findOverflow(page), 'analytics operator 320').toEqual([]);
  await context.close();
});
