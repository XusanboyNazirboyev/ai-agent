import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { findOverflow, fixtures, newSession } from './helpers';

// Settings in four groups (UX review A2, A3).

test('an admin finds everything under four groups, the knowledge base under Assistant', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
    {
      viewport: { width: 1280, height: 800 },
    },
  );
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    await page.goto('/settings/bot');
    const groups = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(groups.getByRole('link')).toHaveCount(4);
    for (const name of ['Assistant', 'Channels', 'Sales', 'Team and account'])
      await expect(groups.getByRole('link', { name })).toHaveCount(1);
    await expect(page.getByTestId('settings-group-assistant')).toHaveAttribute(
      'aria-current',
      'page',
    );
    const tabs = page.getByTestId('settings-subtabs');
    await expect(tabs.getByRole('link')).toHaveText([
      'On and off',
      'Knowledge',
      'Test chat',
    ]);

    // The knowledge base is here, at its old address, inside Settings.
    await page.getByTestId('settings-tab-knowledge').click();
    await page.waitForURL(/\/knowledge$/u);
    await expect(page.getByTestId('settings-tab-knowledge')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: 'Settings' }),
    ).toHaveAttribute('aria-current', 'page');

    await page.getByTestId('settings-tab-test').click();
    await expect(page.getByTestId('test-chat-input')).toBeVisible();

    await page.getByTestId('settings-group-sales').click();
    await page.waitForURL(/\/settings\/pipeline$/u);
    await expect(tabs.getByRole('link')).toHaveText([
      'Sales stages',
      'Price list',
      'Tags and fields',
      'External CRM',
    ]);

    await page.getByTestId('settings-group-account').click();
    await page.waitForURL(/\/settings\/team$/u);
    await expect(tabs.getByRole('link')).toHaveText([
      'Team',
      'Subscription',
      'Security',
      'General',
    ]);
    await page.getByTestId('settings-tab-general').click();
    await page.waitForURL(/\/settings$/u);

    // Channels and the operators' quick replies (ADR 070) share a group.
    await page.getByTestId('settings-group-channels').click();
    await page.waitForURL(/\/settings\/channels$/u);
    await expect(tabs.getByRole('link')).toHaveText([
      'Channels',
      'Quick replies',
    ]);
  } finally {
    await context.close();
  }
});

test('an operator sees only what they may open', async ({ browser }) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email, {
    viewport: { width: 1280, height: 800 },
  });
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    await page.goto('/settings/bot');
    const tabs = page.getByTestId('settings-subtabs');
    // No test chat for an operator.
    await expect(tabs.getByRole('link')).toHaveText([
      'On and off',
      'Knowledge',
    ]);
    await page.getByTestId('settings-group-sales').click();
    await expect(tabs.getByRole('link')).toHaveText([
      'Sales stages',
      'Tags and fields',
      'External CRM',
    ]);
    await page.getByTestId('settings-group-account').click();
    await expect(tabs.getByRole('link')).toHaveText(['Security', 'General']);
  } finally {
    await context.close();
  }
});

test('the groups fit a phone without a sideways scroll and have no accessibility violations', async ({
  browser,
}) => {
  const f = fixtures();
  for (const [language, width] of [
    ['en', 320],
    ['ru', 320],
    ['uz-Latn', 320],
  ] as const) {
    const { page, context } = await newSession(
      browser,
      f.a.operators.admin.email,
      {
        viewport: { width, height: 700 },
      },
    );
    try {
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      for (const path of [
        '/settings/bot',
        '/settings/team',
        '/settings/pipeline',
      ]) {
        await page.goto(path);
        await expect(page.getByTestId('settings-subtabs')).toBeVisible();
        // The four groups are all in view at once (the old row scrolled sideways).
        const groups = page.getByRole('navigation').filter({
          has: page.getByTestId('settings-group-assistant'),
        });
        const box = (await groups.boundingBox())!;
        const scroll = await groups.evaluate(
          (el) => el.scrollWidth - el.clientWidth,
        );
        expect(scroll, `${language} ${path} groups scroll`).toBeLessThanOrEqual(
          0,
        );
        expect(box.width).toBeLessThanOrEqual(width);
        expect(
          await findOverflow(page),
          `overflow ${language} ${path}`,
        ).toEqual([]);
      }
      const result = await new AxeBuilder({ page })
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
