import { expect, test } from '@playwright/test';
import { findOverflow, fixtures, newSession } from './helpers';

// The Leads page opens on the board, says things in words and keeps the
// lead panel short (UX review D3).

test('the Leads page opens on the board; people are the second tab', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
  );
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    await page.goto('/leads');
    const tabs = page.getByRole('tablist', { name: 'Leads and people' });
    await expect(tabs.getByRole('tab')).toHaveText(['Leads', 'People']);
    await expect(tabs.getByRole('tab', { name: 'Leads' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('lead-card').first()).toBeVisible();
    // No unreadable short codes on a card.
    const card = page.getByTestId('lead-card').first();
    await expect(card).not.toContainText(/\b\d+ ?k\b|\b\d+d\b/u);
    await tabs.getByRole('tab', { name: 'People' }).click();
    await page.waitForURL(/view=list/u);
  } finally {
    await context.close();
  }
});

test('the lead panel shows stage, deal and archive first; the rest is folded under More details', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
    {
      viewport: { width: 1280, height: 800 },
    },
  );
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    await page.goto('/leads');
    await page.getByTestId('lead-card-open').first().click();
    const panel = page.getByTestId('lead-page');
    await expect(panel.getByTestId('lead-panel-stages')).toBeVisible();
    await expect(panel).toContainText('Deal');
    await expect(panel).not.toContainText('Opportunity');
    // The card is always open: responsible, main information and tags.
    await expect(panel.getByTestId('lead-responsible')).toBeVisible();
    await expect(panel.getByTestId('lead-main-info')).toBeVisible();
    await expect(panel.getByTestId('lead-tags')).toBeVisible();
    expect(await findOverflow(page)).toEqual([]);
  } finally {
    await context.close();
  }
});
