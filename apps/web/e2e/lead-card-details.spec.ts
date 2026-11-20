import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';
import type { LeadPipelinePage } from '../src/lib/types';

test('lead cards show creation day/time and the full responsible name in every UI language', async ({
  browser,
}, testInfo) => {
  const { page, context } = await newSession(
    browser,
    fixtures().a.operators.owner.email,
    {
      viewport: { width: 1280, height: 800 },
    },
  );
  await page.clock.setFixedTime(new Date('2026-11-19T19:17:00Z'));
  await page.route(
    (url) => url.pathname === '/api/v1/leads',
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as LeadPipelinePage;
      await route.fulfill({
        response,
        json: {
          ...body,
          items: body.items.map((item) => ({
            ...item,
            createdAt: '2026-11-19T05:17:00Z',
            updatedAt: '2026-11-19T19:17:00Z',
            owner: {
              id: fixtures().a.operators.owner.id,
              displayName: 'Muzaffar',
            },
            contact: { ...item.contact, name: 'Zarina' },
          })),
        },
      });
    },
  );
  await page.goto('/leads');
  const card = page.getByTestId('lead-card').first();
  await expect(card).toBeVisible();
  const created = card.getByTestId('lead-card-created');
  for (const [locale, text] of [
    ['uz-Latn', 'Kecha, 10:17 · 14 soat oldin'],
    ['ru', 'Вчера, 10:17 · 14 часов назад'],
    ['en', 'Yesterday, 10:17 · 14 hours ago'],
  ]) {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(locale);
    await expect(created).toHaveText(text);
    await expect(created).toHaveAttribute('datetime', '2026-11-19T05:17:00Z');
    await expect(card.getByTestId('lead-card-owner-name')).toHaveText(
      'Muzaffar',
    );
  }
  await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('uz-Latn');
  await card.screenshot({ path: testInfo.outputPath('lead-card-desktop.png') });
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(created).toBeVisible();
  await expect(card.getByTestId('lead-card-owner-name')).toBeVisible();
  expect(
    await card.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await card.screenshot({ path: testInfo.outputPath('lead-card-mobile.png') });
  const audit = await new AxeBuilder({ page })
    .include('[data-testid="lead-card"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(audit.violations).toEqual([]);
  await card.getByTestId('lead-card-open').click();
  await expect(page.getByTestId('lead-page')).toBeVisible();
  await context.close();
});
