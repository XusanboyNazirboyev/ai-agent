import { expect, test } from '@playwright/test';
import { findOverflow, fixtures, newHandover, newSession } from './helpers';

/**
 * Layout gate: no page may overflow horizontally or let content spill out of
 * its box, at any common width, in any language (Russian and Uzbek labels are
 * the longest). Intentional truncation (text-overflow: ellipsis) and
 * scroll containers are allowed; anything else that spills is a defect.
 */
const VIEWPORTS = [
  { width: 320, height: 640 },
  { width: 375, height: 667 },
  { width: 768, height: 900 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];
const LANGUAGES = ['en', 'ru', 'uz-Latn'] as const;

test('the overflow check itself reports a real overflow (sensitivity check)', async ({
  page,
}) => {
  await page.goto('/login');
  await page.evaluate(() => {
    // Set through the CSSOM: the page's CSP refuses inline style attributes.
    const wide = document.createElement('div');
    wide.textContent = 'wide';
    wide.style.width = '3000px';
    wide.style.height = '10px';
    document.body.append(wide);
  });
  expect((await findOverflow(page)).length).toBeGreaterThan(0);
});

test.describe('no overflow in the signed-in pages', () => {
  // One long unbroken customer name for the whole spec (few rows are added
  // to the shared tenant, so other specs' list assumptions stay valid).
  let longName = '';
  test.beforeAll(() => {
    longName = newHandover(
      fixtures().a.tenantId,
      `Layout ${'Ж'.repeat(40)} ${Date.now()}`,
    ).contactName;
  });

  for (const viewport of VIEWPORTS) {
    test(`${viewport.width}px: inbox, conversation, leads, settings in en, ru and uz`, async ({
      browser,
    }) => {
      const f = fixtures();
      const { page, context } = await newSession(
        browser,
        f.a.operators.op1.email,
        { viewport },
      );
      for (const language of LANGUAGES) {
        await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
        await expect(page.getByTestId('conversation-list')).toBeVisible();
        expect(await findOverflow(page), `inbox ${language}`).toEqual([]);

        await page
          .getByTestId('conversation-item')
          .filter({ hasText: longName.slice(0, 20) })
          .first()
          .click();
        await expect(page.getByTestId('conversation-view')).toBeVisible();
        expect(await findOverflow(page), `conversation ${language}`).toEqual(
          [],
        );

        await page.goto('/leads');
        await expect(page.getByTestId('lead-column-HOT')).toBeAttached();
        await expect(
          page.locator('[data-testid^="lead-column"] [role="status"]'),
        ).toHaveCount(0);
        expect(await findOverflow(page), `leads ${language}`).toEqual([]);

        for (const path of ['/contacts', '/more', '/bot', '/knowledge']) {
          await page.goto(path);
          await expect(page.locator('#app-main [role="region"]')).toBeVisible();
          expect(await findOverflow(page), `${path} ${language}`).toEqual([]);
        }

        await page.goto('/channels');
        await expect(page.getByTestId('channel-account').first()).toBeVisible();
        expect(await findOverflow(page), `channels ${language}`).toEqual([]);

        await page.goto('/settings');
        await expect(page.getByRole('radiogroup')).toBeVisible();
        expect(await findOverflow(page), `settings ${language}`).toEqual([]);

        await page.goto('/inbox');
        await expect(page.getByTestId('conversation-list')).toBeVisible();
      }
      await context.close();
    });
  }

  test('login and the not-found page fit at the narrowest width', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:3010',
      viewport: { width: 320, height: 640 },
    });
    const page = await context.newPage();
    for (const path of ['/login', '/no-such-page']) {
      await page.goto(path);
      for (const language of LANGUAGES) {
        await page.evaluate(
          (value) => localStorage.setItem('ac_locale', value),
          language,
        );
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute(
          'lang',
          language === 'uz-Latn' ? 'uz' : language,
        );
        expect(await findOverflow(page), `${path} ${language}`).toEqual([]);
      }
    }
    await context.close();
  });
});
