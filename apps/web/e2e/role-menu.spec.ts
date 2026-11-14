import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fixtures, newSession } from './helpers';

const VIEWPORT = { width: 1280, height: 800 };

const OPERATOR_ITEMS = ['Inbox', 'Leads', 'Knowledge', 'Settings'];
const ADMIN_ITEMS = ['Inbox', 'Leads', 'Analytics', 'Knowledge', 'Settings'];

async function openAs(
  browser: Parameters<typeof newSession>[0],
  role: 'op1' | 'viewer' | 'admin',
): Promise<Page> {
  const { page } = await newSession(
    browser,
    fixtures().a.operators[role].email,
    {
      viewport: VIEWPORT,
    },
  );
  await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
  return page;
}

test.describe('role-based menu', () => {
  for (const [role, items] of [
    ['op1', OPERATOR_ITEMS],
    ['viewer', OPERATOR_ITEMS],
    ['admin', ADMIN_ITEMS],
  ] as const) {
    test(`${role}: rail shows only allowed items`, async ({ browser }) => {
      const page = await openAs(browser, role);
      const rail = page.getByRole('navigation', { name: 'Main navigation' });
      const links = rail.getByRole('link');
      await expect(links).toHaveCount(items.length);
      for (const name of items)
        await expect(rail.getByRole('link', { name })).toHaveCount(1);
      const hidden = items.length === 5 ? [] : ['Analytics'];
      for (const name of hidden)
        await expect(rail.getByRole('link', { name })).toHaveCount(0);
    });
  }

  test('operator and viewer do not see analytics on the More page either', async ({
    browser,
  }) => {
    for (const role of ['op1', 'viewer'] as const) {
      const page = await openAs(browser, role);
      await page.goto('/more');
      // Inside the page: on a wide screen the side rail has the same names.
      const more = page.locator('#app-main');
      await expect(more.getByRole('link', { name: 'Analytics' })).toHaveCount(
        0,
      );
      await expect(more.getByRole('link', { name: 'Knowledge' })).toHaveCount(
        1,
      );
      await expect(more.getByRole('link', { name: 'Settings' })).toHaveCount(1);
    }
  });

  test('administrator sees analytics on the More page too', async ({
    browser,
  }) => {
    const page = await openAs(browser, 'admin');
    await page.goto('/more');
    for (const name of ['Knowledge', 'Settings', 'Analytics'])
      await expect(
        page.locator('#app-main').getByRole('link', { name }),
      ).toHaveCount(1);
  });
});
