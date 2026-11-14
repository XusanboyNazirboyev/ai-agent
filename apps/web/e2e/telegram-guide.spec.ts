import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { findOverflow, fixtures, newSession } from './helpers';

// The BotFather guide inside the Telegram connect dialog (UX review C2).

test('the guide reads in every language, fits a phone and has no accessibility violations', async ({
  browser,
}) => {
  const f = fixtures();
  for (const [language, width, title] of [
    ['en', 1280, 'Open BotFather'],
    ['ru', 320, 'Откройте BotFather'],
    ['uz-Latn', 320, 'BotFather ni oching'],
  ] as const) {
    const { page, context } = await newSession(
      browser,
      f.a.operators.admin.email,
      { viewport: { width, height: 700 } },
    );
    try {
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await page.goto('/settings/channels');
      await page.getByTestId('connect-telegram').click();
      const guide = page.getByTestId('botfather-guide');
      await expect(guide).toContainText(title);
      await expect(guide.getByRole('listitem')).toHaveCount(4);
      expect(
        await findOverflow(page),
        `overflow ${language} ${width}px`,
      ).toEqual([]);
      const result = await new AxeBuilder({ page })
        .include('[data-testid="telegram-connect-dialog"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        .analyze();
      expect(
        result.violations.map(
          (v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`,
        ),
        `axe ${language}`,
      ).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
