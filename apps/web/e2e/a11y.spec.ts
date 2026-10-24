import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fixtures, newHandover, newSession } from './helpers';

/**
 * Automated accessibility audit of the rendered pages (axe-core: WCAG 2.2 A/AA
 * and best practices, including colour contrast in the real theme). Automated
 * rules find roughly a third of the problems; keyboard and screen-reader use
 * are checked by hand and by the interaction tests in the other specs.
 */
const TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
  'best-practice',
];

async function audit(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = result.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(' '))
        .join(' | ')}`,
  );
  expect(summary, label).toEqual([]);
}

test('the audit itself reports real violations (sensitivity check)', async ({
  page,
}) => {
  await page.goto('/login');
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<button></button><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
    );
  });
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const ids = result.violations.map((violation) => violation.id);
  expect(ids).toContain('button-name');
  expect(ids).toContain('image-alt');
});

test.describe('login page', () => {
  for (const [scheme, language] of [
    ['light', 'en'],
    ['dark', 'en'],
    ['light', 'ru'],
    ['light', 'uz-Latn'],
  ] as const) {
    test(`has no violations (${scheme}, ${language})`, async ({ browser }) => {
      const context = await browser.newContext({
        baseURL: 'http://127.0.0.1:3010',
        colorScheme: scheme,
      });
      const page = await context.newPage();
      await page.goto('/login');
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await expect(page.locator('html')).toHaveAttribute(
        'lang',
        language === 'uz-Latn' ? 'uz' : language,
      );
      await audit(page, `login ${scheme} ${language}`);
      await context.close();
    });
  }
});

test.describe('inbox', () => {
  for (const [scheme, language, viewport] of [
    ['light', 'en', { width: 1280, height: 800 }],
    ['dark', 'en', { width: 1280, height: 800 }],
    ['light', 'ru', { width: 1280, height: 800 }],
    ['light', 'uz-Latn', { width: 1280, height: 800 }],
    ['light', 'en', { width: 375, height: 667 }],
    ['dark', 'en', { width: 375, height: 667 }],
  ] as const) {
    test(`list, conversation and details have no violations (${scheme}, ${language}, ${viewport.width}px)`, async ({
      browser,
    }) => {
      const f = fixtures();
      const handover = newHandover(f.a.tenantId, `A11y ${Date.now()}`);
      const { page, context } = await newSession(
        browser,
        f.a.operators.op1.email,
        { viewport, colorScheme: scheme },
      );
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await expect(page.getByTestId('conversation-list')).toBeVisible();
      await audit(page, `list ${scheme} ${language} ${viewport.width}`);

      await page
        .getByTestId('conversation-item')
        .filter({ hasText: handover.contactName })
        .click();
      await expect(page.getByTestId('conversation-view')).toBeVisible();
      await audit(page, `conversation ${scheme} ${language} ${viewport.width}`);

      if (viewport.width < 1024) {
        await page.getByRole('button', { name: 'Details' }).click();
        await expect(page.locator('#conversation-details')).toBeVisible();
        await audit(page, `details ${scheme} ${language} ${viewport.width}`);
      }
      await context.close();
    });
  }

  test('the reply composer and the confirmation dialog have no violations', async ({
    browser,
  }) => {
    const f = fixtures();
    const handover = newHandover(f.a.tenantId, `A11y act ${Date.now()}`);
    const { page, context } = await newSession(
      browser,
      f.a.operators.op1.email,
    );
    await page
      .getByTestId('conversation-item')
      .filter({ hasText: handover.contactName })
      .click();
    await page.getByTestId('take-over').click();
    await expect(page.getByTestId('reply-input')).toBeVisible();
    await audit(page, 'composer');
    await page.getByTestId('close').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await audit(page, 'confirmation dialog');
    // Focus starts on the safe choice and Escape returns it to the page.
    await expect(page.getByTestId('confirm-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByTestId('close')).toBeFocused();
    await context.close();
  });
});

test('keyboard: the scope tabs follow the arrow keys and a skip link is first', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  await expect(page.getByTestId('conversation-list')).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: 'Skip to conversations' }),
  ).toBeFocused();

  const waiting = page.getByRole('tab', { name: /^Waiting/u });
  await waiting.focus();
  await page.keyboard.press('ArrowRight');
  const mine = page.getByRole('tab', { name: 'Mine' });
  await expect(mine).toHaveAttribute('aria-selected', 'true');
  await expect(mine).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Closed' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /^Waiting/u })).toBeFocused();
  // Only the selected tab is in the tab order.
  await expect(page.getByRole('tab', { name: 'Closed' })).toHaveAttribute(
    'tabindex',
    '-1',
  );
  await context.close();
});
