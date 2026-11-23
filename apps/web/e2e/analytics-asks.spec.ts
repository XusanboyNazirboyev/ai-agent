import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { findOverflow, fixtures, newSession } from './helpers';

// "What customers ask" on Analytics (ADR 063 S1). The e2e turns carry no
// intent, so the counts are injected into the real report.

const ASKS = [
  { intent: 'price', count: 12, handedOver: 4, noData: 3 },
  { intent: 'human_request', count: 5, handedOver: 5, noData: 0 },
  { intent: 'greeting', count: 2, handedOver: 0, noData: 0 },
];

async function withAsks(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/v1/analytics',
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      return route.fulfill({ response, json: { ...body, asks: ASKS } });
    },
  );
}

test('the card lists what customers asked, who answered, and where to add missing answers', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
  );
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    await withAsks(page);
    await page.goto('/analytics');
    const card = page.getByTestId('analytics-asks');
    await expect(card).toContainText('What customers ask');
    const rows = card.getByTestId('analytics-ask');
    await expect(rows).toHaveCount(3);
    // Intent codes read as words.
    await expect(rows.first()).toContainText('Price');
    await expect(card).not.toContainText('human_request');
    await expect(rows.first()).toContainText('Assistant answered 8');
    await expect(rows.first()).toContainText('a person took 4');
    await expect(rows.first()).toContainText('no data for 3');
    const fix = page.getByTestId('analytics-asks-fix');
    await expect(fix.getByRole('link', { name: 'Knowledge' })).toHaveAttribute(
      'href',
      '/agent/knowledge',
    );
    await expect(fix.getByRole('link', { name: 'Price list' })).toHaveAttribute(
      'href',
      '/agent/prices',
    );
  } finally {
    await context.close();
  }
});

test('the card fits a phone in ru and uz-Latn and has no accessibility violations', async ({
  browser,
}) => {
  const f = fixtures();
  for (const language of ['ru', 'uz-Latn'] as const) {
    const { page, context } = await newSession(
      browser,
      f.a.operators.admin.email,
      {
        viewport: { width: 320, height: 700 },
      },
    );
    try {
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await withAsks(page);
      await page.goto('/analytics');
      await expect(page.getByTestId('analytics-ask')).toHaveCount(3);
      expect(await findOverflow(page), `overflow ${language}`).toEqual([]);
      const result = await new AxeBuilder({ page })
        .include('[data-testid="analytics-asks"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        .analyze();
      expect(
        result.violations.map((v) => v.id),
        `axe ${language}`,
      ).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
