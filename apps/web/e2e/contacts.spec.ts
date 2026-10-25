import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';

test('contacts list the tenant customers, search and open their conversation', async ({
  browser,
}) => {
  const f = fixtures();
  const first = f.a.conversations[0];
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  await page.goto('/contacts');
  const row = page
    .getByTestId('contact-item')
    .filter({ hasText: first.contactName });
  await expect(row).toBeVisible();
  await page.getByLabel('Search by name or phone').fill(first.contactName);
  await expect(page.getByTestId('contact-item')).toHaveCount(1);
  await page.getByLabel('Search by name or phone').fill('no-such-contact-xyz');
  await expect(page.getByTestId('contact-item')).toHaveCount(0);
  await page.getByLabel('Search by name or phone').fill(first.contactName);
  await page.getByRole('link', { name: 'Open conversation' }).click();
  await expect(page.getByTestId('conversation-view')).toBeVisible();
  await context.close();

  // Another tenant's contacts never appear.
  const other = await newSession(browser, f.b.operators.op1.email);
  await other.page.goto('/contacts');
  await expect(other.page.getByTestId('contact-item').first()).toBeVisible();
  await expect(
    other.page
      .getByTestId('contact-item')
      .filter({ hasText: first.contactName }),
  ).toHaveCount(0);
  await other.context.close();
});

test('on a phone the tab bar has four entries and More leads to the rest', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email, {
    viewport: { width: 375, height: 667 },
  });
  const bar = page.getByRole('navigation').last();
  await expect(bar.getByRole('link')).toHaveCount(4);
  await bar.getByRole('link', { name: 'More' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('More');
  await page.getByRole('link', { name: /AI bot/u }).click();
  await expect(page.getByTestId('bot-current').first()).toBeVisible();
  // "More" stays marked as the current section.
  await expect(
    page.getByRole('navigation').last().getByRole('link', { name: 'More' }),
  ).toHaveAttribute('aria-current', 'page');
  await context.close();
});
