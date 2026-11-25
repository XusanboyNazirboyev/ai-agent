import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { findOverflow } from './helpers';

const SCRATCH = process.env.SITE_SHOTS;

test('a demo message stays readable while the conversation animates', async ({
  page,
}) => {
  await page.goto('/');
  const message = page
    .getByTestId('site-chat-demo')
    .locator('li:not([aria-hidden])')
    .first();
  await expect(message).toBeVisible();
  await expect(
    page.getByTestId('site-chat-demo').locator('li:not([aria-hidden])').nth(1),
  ).toBeVisible();
  const result = await message.evaluate((element) => {
    // Sample the faint part of any entrance animation without racing its duration.
    for (const animation of element.getAnimations()) {
      animation.pause();
      animation.currentTime = 30;
    }
    return getComputedStyle(element).opacity;
  });
  expect(result).toBe('1');
});

// Owner 2026-11-24: the sales page opens with the demo sale, shows what
// changes, and ends with a "contact us" form that reaches the sales team.
for (const [width, language, colorScheme] of [
  [320, 'uz-Latn', 'light'],
  [1280, 'en', 'light'],
  [390, 'ru', 'dark'],
] as const) {
  test(`the sales page at ${width}px in ${language}: navigation, demo and contact`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      reducedMotion: 'reduce',
      colorScheme,
    });
    const page = await context.newPage();
    try {
      await page.goto('/');
      await page.getByRole('combobox').selectOption(language);
      await expect(page.locator('html')).toHaveAttribute(
        'lang',
        language === 'uz-Latn' ? 'uz' : language,
      );
      await expect(page.getByTestId('site-cta')).toHaveAttribute(
        'href',
        '/signup',
      );
      await expect(page.getByTestId('site-chat-demo')).toBeVisible();
      await expect(page.getByTestId('site-demo-lead')).toBeVisible();
      await expect(page.getByTestId('site-results')).toBeVisible();
      expect(await findOverflow(page)).toEqual([]);
      // The CI runner's fonts are wider (the demo logo spilled there at
      // 320px only); letter spacing stands in for them, as in layout.spec.ts.
      await page.evaluate(() => {
        document.documentElement.style.letterSpacing = '0.07em';
      });
      expect(await findOverflow(page)).toEqual([]);
      await page.evaluate(() => {
        document.documentElement.style.letterSpacing = '';
      });
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(
        result.violations.map(
          (v) =>
            `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
        ),
      ).toEqual([]);
      if (SCRATCH)
        await page.screenshot({
          path: `${SCRATCH}/site-${width}.png`,
          fullPage: true,
        });

      for (const target of ['product', 'pricing', 'faq']) {
        await page.locator(`header a[href="#${target}"]`).click();
        await expect(page).toHaveURL(new RegExp(`#${target}$`, 'u'));
      }
      const question = page.locator('#faq details').first();
      await question.locator('summary').click();
      await expect(question.locator('p')).toBeVisible();
      await page.getByTestId('site-enterprise-contact').click();
      await expect(page).toHaveURL(/#contact$/u);

      await page.getByTestId('site-contact-name').fill('E2E Visitor');
      await page
        .getByTestId('site-contact-phone')
        .fill(`+998 90 ${String(Date.now()).slice(-7)}`);
      await page.getByTestId('site-contact-submit').click();
      await expect(page.getByTestId('site-contact-done')).toBeVisible();
    } finally {
      await context.close();
    }
  });
}
