import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { findOverflow, fixtures, newHandover, newSession } from './helpers';

// The Today home page (UX review A4): who is waiting, the assistant as a
// traffic light, and the getting-started list for admins.

test('the page opens after sign-in, counts the waiting customers and leads to them', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Today ${Date.now()}`);
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:3010',
  });
  const page = await context.newPage();
  try {
    await page.goto('/login');
    await page.getByLabel('Email').fill(f.a.operators.op1.email);
    await page.getByLabel('Password').fill(f.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Signing in lands on Today, not on the inbox.
    await page.waitForURL(/\/today/u);
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    await expect(page.getByRole('heading', { level: 2 })).toContainText(
      /Good (morning|afternoon|evening)/u,
    );
    await expect(page.getByTestId('today-lead')).toContainText(
      /customers? (is|are) waiting for you/u,
    );
    const value = Number(
      await page.getByTestId('today-waiting-value').innerText(),
    );
    expect(value).toBeGreaterThanOrEqual(1);
    // The same number as the badge on the Inbox item.
    await expect(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: /Inbox/u }),
    ).toContainText(String(Math.min(value, 99)));

    // An operator sees the assistant but not the setup list nor a settings link.
    await expect(page.getByTestId('today-assistant')).toBeVisible();
    await expect(page.getByTestId('today-setup')).toHaveCount(0);
    await expect(
      page.getByTestId('today-assistant').getByRole('link'),
    ).toHaveCount(0);

    await page.getByTestId('today-waiting').click();
    await page.waitForURL(/\/inbox/u);
    await expect(
      page
        .getByTestId('conversation-item')
        .filter({ hasText: handover.contactName }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test('an admin sees the assistant light and the getting-started list with a place to do each step', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    await page.goto('/today');
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    const light = page.getByTestId('today-assistant');
    await expect(light).toBeVisible();
    await expect(light).toHaveAttribute(
      'data-light',
      /^(live|drafts|hold|off|none)$/u,
    );
    await expect(light.getByRole('link')).toHaveCount(1);

    const setup = page.getByTestId('today-setup');
    await expect(setup).toBeVisible();
    await expect(page.getByTestId('today-setup-progress')).toContainText(
      /^\d of 6 done$/u,
    );
    for (const key of [
      'channel',
      'content',
      'test',
      'assistant',
      'team',
      'group',
    ]) {
      const step = page.getByTestId(`today-step-${key}`);
      await expect(step).toBeVisible();
      // An open step has a link to where it is done; a done one says so.
      if ((await step.getAttribute('data-done')) === 'false')
        await expect(step.getByRole('link')).toHaveAttribute(
          'href',
          /^\/settings\//u,
        );
      else await expect(step).toContainText('Done');
    }
    // The tabs are in the menu on every page: Today is the first item.
    await expect(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link')
        .first(),
    ).toHaveText('Today');
  } finally {
    await context.close();
  }
});

test('the Today page has no accessibility violations and fits a phone in en, ru and uz-Latn', async ({
  browser,
}) => {
  const f = fixtures();
  for (const [language, width] of [
    ['en', 1280],
    ['ru', 320],
    ['uz-Latn', 320],
  ] as const) {
    const { page, context } = await newSession(
      browser,
      f.a.operators.admin.email,
      { viewport: { width, height: 700 } },
    );
    try {
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await page.goto('/today');
      await expect(page.getByTestId('today-setup')).toBeVisible();
      await expect(page.getByTestId('today-assistant')).toBeVisible();
      expect(
        await findOverflow(page),
        `overflow ${language} ${width}px`,
      ).toEqual([]);
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
