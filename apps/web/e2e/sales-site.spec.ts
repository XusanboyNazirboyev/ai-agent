import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { findOverflow } from './helpers';

const SCRATCH = process.env.SITE_SHOTS;

// Owner 2026-11-24: the sales page opens with the demo sale, shows what
// changes, and ends with a "contact us" form that reaches the sales team.
for (const width of [320, 1280]) {
  test(`the sales page at ${width}px: demo, results, contact form`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      reducedMotion: 'reduce',
      locale: 'uz-UZ',
    });
    const page = await context.newPage();
    try {
      await page.goto('/');
      await expect(page.getByTestId('site-chat-demo')).toBeVisible();
      await expect(page.getByTestId('site-demo-lead')).toBeVisible();
      await expect(page.getByTestId('site-results')).toBeVisible();
      expect(await findOverflow(page)).toEqual([]);
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
