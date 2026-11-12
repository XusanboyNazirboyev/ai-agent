import { expect, test } from '@playwright/test';
import { fixtures, login, nextClientAddress } from './helpers';

const PAGES = [
  '/inbox',
  '/leads',
  '/contacts',
  '/analytics',
  '/channels',
  '/bot',
  '/knowledge',
  '/more',
  '/settings',
  '/settings/fields',
  '/settings/team',
];

test.describe('Content-Security-Policy on every main page', () => {
  test('no page raises a CSP violation (scripts, stylesheets, inline styles)', async ({
    browser,
  }) => {
    const f = fixtures();
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:3010',
      extraHTTPHeaders: { 'x-forwarded-for': nextClientAddress() },
    });
    const page = await context.newPage();
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy|Refused to/iu.test(message.text()))
        violations.push(`${page.url()} :: ${message.text()}`);
    });
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        console.error(
          `Refused to ... CSP violation: ${event.violatedDirective} ${event.blockedURI} ${event.sample ?? ''}`,
        );
      });
    });
    await login(page, f.a.operators.owner.email, f.password);
    for (const path of PAGES) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
    }
    // Client-side navigation too (Next injects route stylesheets then).
    await page.goto('/inbox');
    for (const name of ['Leads', 'Contacts', 'Analytics']) {
      const link = page.getByRole('link', { name, exact: true }).first();
      if (await link.count()) await link.click();
      await page.waitForLoadState('networkidle');
    }
    expect(violations).toEqual([]);
    await expect(page.locator('body')).toBeVisible();
    await context.close();
  });
});
