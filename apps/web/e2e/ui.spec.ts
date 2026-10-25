import { expect, test } from '@playwright/test';
import { fixtures, login, newSession } from './helpers';

test('the interface switches between English, Russian and Uzbek and remembers the choice', async ({
  page,
}) => {
  const f = fixtures();
  await login(page, f.a.operators.op1.email, f.password);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByLabel('Language', { exact: true }).selectOption('ru');
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Ожидают' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await page.getByLabel('Язык', { exact: true }).selectOption('uz-Latn');
  await expect(page.getByRole('button', { name: 'Chiqish' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'uz');
});

test('the login form is localized too', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Language', { exact: true }).selectOption('ru');
  await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
});

test.describe('phone viewport', () => {
  test('list and conversation are used one at a time without horizontal scrolling', async ({
    browser,
  }) => {
    const f = fixtures();
    const { page, context } = await newSession(
      browser,
      f.a.operators.op1.email,
      {
        viewport: { width: 375, height: 667 },
      },
    );
    const overflow = (): Promise<boolean> =>
      page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
    await expect(page.getByTestId('conversation-list')).toBeVisible();
    expect(await overflow()).toBe(false);
    await page.getByTestId('conversation-item').first().click();
    await expect(page.getByTestId('conversation-view')).toBeVisible();
    await expect(page.getByTestId('conversation-list')).toBeHidden();
    expect(await overflow()).toBe(false);
    await page.getByRole('button', { name: 'Back to list' }).click();
    await expect(page.getByTestId('conversation-list')).toBeVisible();
    await context.close();
  });
});

test('customer text is shown as plain text, never as HTML', async ({
  browser,
}) => {
  const f = fixtures();
  const { newHandover, customerMessage } = await import('./helpers');
  const handover = newHandover(f.a.tenantId, `Xss ${Date.now()}`);
  customerMessage(
    f.a.tenantId,
    handover.id,
    '<img src=x onerror="window.__pwned=1"><b>bold</b>',
  );
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  await page
    .getByTestId('conversation-item')
    .filter({ hasText: handover.contactName })
    .click();
  await expect(page.getByTestId('timeline')).toContainText(
    '<img src=x onerror="window.__pwned=1"><b>bold</b>',
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { __pwned?: number }).__pwned,
    ),
  ).toBeUndefined();
  expect(
    await page
      .locator('[data-testid="timeline"] img, [data-testid="timeline"] b')
      .count(),
  ).toBe(0);
  await context.close();
});

test('the response carries a restrictive security header set', async ({
  request,
}) => {
  const response = await request.get('/login');
  const csp = response.headers()['content-security-policy'];
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("default-src 'self'");
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['x-powered-by']).toBeUndefined();
});
