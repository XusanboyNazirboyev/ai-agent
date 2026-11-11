import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';

test('contacts list the tenant customers, search and open their conversation', async ({
  browser,
}) => {
  const f = fixtures();
  const first = f.a.conversations[0];
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  await page.goto('/leads?view=list');
  const row = page
    .getByTestId('person-item')
    .filter({ hasText: first.contactName });
  await expect(row).toBeVisible();
  await page.getByLabel('Search by name or phone').fill(first.contactName);
  await expect(page.getByTestId('person-item')).toHaveCount(1);
  await page.getByLabel('Search by name or phone').fill('no-such-contact-xyz');
  await expect(page.getByTestId('person-item')).toHaveCount(0);
  await page.getByLabel('Search by name or phone').fill(first.contactName);
  await page.getByRole('link', { name: 'Open conversation' }).click();
  await expect(page.getByTestId('conversation-view')).toBeVisible();
  await context.close();

  // Another tenant's contacts never appear.
  const other = await newSession(browser, f.b.operators.op1.email);
  await other.page.goto('/leads?view=list');
  await expect(other.page.getByTestId('person-item').first()).toBeVisible();
  await expect(
    other.page
      .getByTestId('person-item')
      .filter({ hasText: first.contactName }),
  ).toHaveCount(0);
  await other.context.close();
});

test('on a phone the tab bar has three entries and settings leads to its sections', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email, {
    viewport: { width: 375, height: 667 },
  });
  const bar = page.getByRole('navigation').last();
  await expect(bar.getByRole('link')).toHaveCount(3);
  await bar.getByRole('link', { name: 'More' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('More');
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'AI bot' }).click();
  await expect(page.getByTestId('bot-current').first()).toBeVisible();
  // "More" stays marked as the current section.
  await expect(
    page.getByRole('navigation').last().getByRole('link', { name: 'More' }),
  ).toHaveAttribute('aria-current', 'page');
  await context.close();
});
