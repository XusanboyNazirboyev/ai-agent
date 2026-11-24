import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fixtures, newSession } from './helpers';

// On a slow connection every click used to look frozen: the old page stayed
// until the server answered the navigation. A click must switch to the new
// address at once and show that the page is loading while that answer is
// still on its way.
const SERVER_DELAY_MS = 3_000;
const FEEDBACK_MS = 1_000;

/** Holds every navigation answer (not prefetches) for `pathPart` back. */
async function slowNavigation(page: Page, pathPart: string): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith(pathPart),
    async (route) => {
      const headers = route.request().headers();
      if (headers.rsc === '1' && !headers['next-router-prefetch'])
        await new Promise((resolve) => setTimeout(resolve, SERVER_DELAY_MS));
      await route.continue();
    },
  );
}

/** Gives automatic prefetching a moment, as a person reading the page would. */
async function settle(page: Page, pathPart: string): Promise<void> {
  await page
    .waitForRequest(
      (request) =>
        new URL(request.url()).pathname.startsWith(pathPart) &&
        Boolean(request.headers()['next-router-prefetch']),
      { timeout: 5_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(300);
}

test.describe('navigation on a slow server', () => {
  test('pointing at Inbox starts its reads, so the list opens with its data', async ({
    browser,
  }) => {
    const { page } = await newSession(
      browser,
      fixtures().a.operators.op1.email,
      { viewport: { width: 1280, height: 800 } },
    );
    await page.goto('/today');
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    const inbox = page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: /Inbox/u });
    const listed = page.waitForResponse((response) =>
      response.url().includes('/api/v1/inbox/conversations?scope=all'),
    );
    await inbox.hover();
    await listed;
    // From now on the list answer is slow: only a prefetched list is fast.
    await page.route(
      '**/api/v1/inbox/conversations?scope=all*',
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, SERVER_DELAY_MS));
        await route.continue();
      },
    );
    await inbox.click();
    await expect(page.getByTestId('conversation-item').first()).toBeVisible({
      timeout: FEEDBACK_MS + 500,
    });
  });

  test('a menu click shows the new page loading at once', async ({
    browser,
  }) => {
    const { page } = await newSession(
      browser,
      fixtures().a.operators.op1.email,
      { viewport: { width: 1280, height: 800 } },
    );
    await page.goto('/today');
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await settle(page, '/leads');
    await slowNavigation(page, '/leads');

    await rail.getByRole('link', { name: 'CRM' }).click();
    await expect(page).toHaveURL(/\/leads$/u, { timeout: FEEDBACK_MS });
    // Menu pages are prefetched in full (2026-11-24): the page itself may
    // already be here; otherwise its loading state shows. Never the old page.
    await expect(
      page
        .getByTestId('page-loading')
        .or(page.getByRole('heading', { level: 1, name: 'CRM' })),
    ).toBeVisible({ timeout: FEEDBACK_MS });
    await expect(
      page.getByRole('heading', { level: 1, name: 'CRM' }),
    ).toBeVisible({ timeout: SERVER_DELAY_MS + 7_000 });
    await expect(page.getByTestId('page-loading')).toHaveCount(0);
  });

  test('opening a lead from the board shows it loading at once', async ({
    browser,
  }) => {
    const { page } = await newSession(
      browser,
      fixtures().a.operators.op1.email,
      { viewport: { width: 1280, height: 800 } },
    );
    await page.goto('/leads');
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    const card = page.locator('a[href^="/leads/"]').first();
    await expect(card).toBeVisible();
    await settle(page, '/leads/');
    await slowNavigation(page, '/leads/');

    await card.click();
    await expect(page).toHaveURL(/\/leads\/[^/?]+$/u, { timeout: FEEDBACK_MS });
    await expect(page.getByTestId('page-loading')).toBeVisible({
      timeout: FEEDBACK_MS,
    });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({
      timeout: SERVER_DELAY_MS + 7_000,
    });
  });
});
