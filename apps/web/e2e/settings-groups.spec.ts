import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { findOverflow, fixtures, newSession } from './helpers';

// Settings in three groups (UX review A2); the assistant is its own AI agent
// section, first in the menu (owner 2026-11-23).

test('an admin finds the AI agent first, with its five tabs, and settings in three groups', async ({
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
    const menu = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(menu.getByRole('link').first()).toHaveText('AI agent');
    // Old addresses lead into the new section.
    await page.goto('/settings/bot');
    await page.waitForURL(/\/agent$/u);
    await expect(menu.getByRole('link', { name: 'AI agent' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const agentTabs = page.getByTestId('agent-tabs');
    await expect(agentTabs.getByRole('link')).toHaveText([
      'Overview',
      'Knowledge base',
      'Rules',
      'Prices (catalog)',
      'Test',
    ]);
    await page.getByTestId('agent-tab-knowledge').click();
    await page.waitForURL(/\/agent\/knowledge$/u);
    await page.getByTestId('agent-tab-rules').click();
    await expect(page.getByTestId('business-profile')).toBeVisible();
    await expect(page.getByTestId('agent-rules')).toBeVisible();
    await page.getByTestId('agent-tab-test').click();
    await expect(page.getByTestId('test-chat-input')).toBeVisible();
    await page.goto('/knowledge');
    await page.waitForURL(/\/agent\/knowledge$/u);

    await page.goto('/settings/pipeline');
    const groups = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(groups.getByRole('link')).toHaveCount(3);
    for (const name of ['Integrations', 'Sales', 'General'])
      await expect(groups.getByRole('link', { name })).toHaveCount(1);
    const tabs = page.getByTestId('settings-subtabs');
    await page.getByTestId('settings-group-sales').click();
    await page.waitForURL(/\/settings\/pipeline$/u);
    await expect(tabs.getByRole('link')).toHaveText([
      'Sales stages',
      'Tags and fields',
    ]);

    await page.getByTestId('settings-group-account').click();
    await page.waitForURL(/\/settings\/team$/u);
    await expect(tabs.getByRole('link')).toHaveText([
      'Team',
      'Security',
      'History',
      'General',
    ]);
    // ADR 074: the workspace audit log opens for an admin.
    await page.getByTestId('settings-tab-history').click();
    await page.waitForURL(/\/settings\/history$/u);
    await expect(
      page.getByText(/^Who changed what in this workspace/u),
    ).toBeVisible();
    await expect(page.getByTestId('audit-category')).toBeVisible();
    await page.getByTestId('settings-tab-general').click();
    await page.waitForURL(/\/settings$/u);

    // Owner 2026-11-24: CRMs and telephony under integrations; quick
    // replies moved to the Channels section.
    await page.getByTestId('settings-group-integrations').click();
    await page.waitForURL(/\/settings\/crm$/u);
    await expect(tabs.getByRole('link')).toHaveText([
      'External CRM',
      'Telephony',
    ]);
    await page.getByTestId('settings-tab-telephony').click();
    await page.waitForURL(/\/settings\/telephony$/u);
    await page.goto('/settings/replies');
    await page.waitForURL(/\/channels\/replies$/u);
    await expect(page.getByTestId('channels-tab-replies')).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Owner 2026-11-24: every messenger has its own tab, none goes missing.
    await expect(
      page.getByTestId('channels-tabs').getByRole('link'),
    ).toHaveText([
      'Telegram',
      'Instagram',
      'Messenger',
      'WhatsApp',
      'Web chat',
      'Quick replies',
    ]);
    await page.getByTestId('channels-tab-facebook').click();
    await page.waitForURL(/\/channels\/facebook$/u);
    await expect(page.getByTestId('channel-card-facebook')).toBeVisible();
    await page.getByTestId('channels-tab-whatsapp').click();
    await expect(page.getByTestId('channel-card-whatsapp')).toBeVisible();
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
    await page.goto('/agent');
    // No prices or test chat for an operator.
    await expect(page.getByTestId('agent-tabs').getByRole('link')).toHaveText([
      'Overview',
      'Knowledge base',
      'Rules',
    ]);
    await page.goto('/settings/pipeline');
    const tabs = page.getByTestId('settings-subtabs');
    await page.getByTestId('settings-group-sales').click();
    await expect(tabs.getByRole('link')).toHaveText([
      'Sales stages',
      'Tags and fields',
    ]);
    await page.getByTestId('settings-group-account').click();
    await expect(tabs.getByRole('link')).toHaveText(['Security', 'General']);
    // No telephony tab (owners and admins only), so no sub-tab row.
    await page.getByTestId('settings-group-integrations').click();
    await page.waitForURL(/\/settings\/crm$/u);
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
      for (const path of ['/settings/team', '/settings/pipeline']) {
        await page.goto(path);
        await expect(page.getByTestId('settings-subtabs')).toBeVisible();
        // The groups are all in view at once (the old row scrolled sideways).
        const groups = page.getByRole('navigation').filter({
          has: page.getByTestId('settings-group-integrations'),
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
      await page.goto('/agent');
      await expect(page.getByTestId('agent-tabs')).toBeVisible();
      expect(await findOverflow(page), `overflow ${language} /agent`).toEqual(
        [],
      );
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
