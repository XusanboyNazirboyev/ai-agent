import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { findOverflow, fixtures, newHandover, newSession } from './helpers';

// The compact inbox: a row says who, what was last said and when, and gets a
// chip only for what needs attention; filters hide behind a button; the
// details panel is an accordion whose choices are remembered.

test('a row shows the last message and only the chips that matter', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Compact ${Date.now()}`);
  const { page, context } = await newSession(browser, f.a.operators.op1.email, {
    viewport: { width: 1280, height: 800 },
  });
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    const row = page
      .getByTestId('conversation-item')
      .filter({ hasText: handover.contactName });
    await expect(row).toBeVisible();
    // The newest message, one line, as plain text.
    await expect(row).toContainText('New customer');
    // A waiting customer has its chip; there is no "Bot active" line on a row.
    await expect(row).toContainText(/Waiting \d+ minutes?/u);
    await expect(
      page
        .getByTestId('conversation-item')
        .filter({ hasText: 'Assistant active' }),
    ).toHaveCount(0);
    // Compact: a row with one chip is far shorter than the old three-line card.
    const box = (await row.boundingBox())!;
    expect(box.height).toBeLessThan(96);
  } finally {
    await context.close();
  }
});

test('the filters are behind a button that shows how many are on', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email, {
    viewport: { width: 1280, height: 800 },
  });
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    const toggle = page.getByTestId('inbox-filters-toggle');
    await expect(page.getByTestId('inbox-filters')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(page.getByTestId('inbox-filters')).toBeVisible();
    // Language and score sit side by side, wide enough to read; the tag
    // filter takes the next row (owner screenshot 2026-11-16).
    const boxes = await page
      .getByTestId('inbox-filters')
      .getByRole('combobox')
      .evaluateAll((els) =>
        els.map((el) => el.parentElement!.getBoundingClientRect().toJSON()),
      );
    expect(boxes).toHaveLength(3);
    expect(boxes[0].width).toBeGreaterThan(110);
    expect(boxes[1].width).toBeGreaterThan(110);
    expect(Math.abs(boxes[0].top - boxes[1].top)).toBeLessThan(2);
    expect(boxes[2].top).toBeGreaterThan(boxes[0].bottom);
    await page
      .getByTestId('inbox-filters')
      .getByRole('combobox')
      .first()
      .selectOption('ru');
    await expect(toggle).toHaveAccessibleName('Filters (1 on)');
    // Closing the panel keeps the filter on and says so.
    await toggle.click();
    await expect(page.getByTestId('inbox-filters')).toHaveCount(0);
    await expect(toggle).toHaveAccessibleName('Filters (1 on)');
  } finally {
    await context.close();
  }
});

test('the details panel is an accordion: summaries when closed, choices remembered', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Panel ${Date.now()}`);
  const { page, context } = await newSession(browser, f.a.operators.op1.email, {
    viewport: { width: 1440, height: 900 },
  });
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    await page
      .getByTestId('conversation-item')
      .filter({ hasText: handover.contactName })
      .click();
    const panel = page.locator('#conversation-details');
    const contact = panel.locator('summary').filter({ hasText: 'Contact' });
    const handoverRow = panel
      .locator('summary')
      .filter({ hasText: 'Needs an operator' });
    await expect(handoverRow).toBeVisible();
    // The handover is open by default; contact is closed and says what is inside.
    await expect(panel.getByText('Reason:')).toBeVisible();
    await expect(contact).toContainText('+998');
    await expect(panel.getByText('Phone: ')).toBeHidden();

    await contact.click();
    await expect(contact.locator('xpath=ancestor::details[1]')).toHaveAttribute(
      'open',
      '',
    );
    // Remembered: a reload keeps it open.
    await page.reload();
    await page
      .getByTestId('conversation-item')
      .filter({ hasText: handover.contactName })
      .click();
    await expect(
      page
        .locator('#conversation-details summary')
        .filter({ hasText: 'Contact' })
        .locator('xpath=ancestor::details[1]'),
    ).toHaveAttribute('open', '');

    // The whole panel folds away on a wide screen, and stays folded.
    const fold = page.getByTestId('details-panel-toggle');
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await fold.click();
    await expect(panel).toBeHidden();
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await page.reload();
    await page
      .getByTestId('conversation-item')
      .filter({ hasText: handover.contactName })
      .click();
    await expect(page.getByTestId('conversation-view')).toBeVisible();
    await expect(panel).toBeHidden();
    await fold.click();
    await expect(panel).toBeVisible();
  } finally {
    await context.close();
  }
});

test('on a short laptop screen the messages get most of the height and the reply box is one row until it needs more', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Short ${Date.now()}`);
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
    {
      viewport: { width: 1195, height: 715 },
    },
  );
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    await page
      .getByTestId('conversation-item')
      .filter({ hasText: handover.contactName })
      .click();
    const log = page.locator('section:has(> ol[data-testid="timeline"])');
    const input = page.getByTestId('reply-input');
    await expect(input).toBeVisible();
    const logBox = (await log.boundingBox())!;
    // The conversation pane is the room between the app header and the composer.
    expect(logBox.height).toBeGreaterThan(715 * 0.5);
    // The side menu and the conversation list leave the room to the messages.
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    expect((await rail.boundingBox())!.width).toBeLessThanOrEqual(76);
    const list = page.getByTestId('conversation-list');
    expect((await list.boundingBox())!.width).toBeLessThanOrEqual(305);
    expect(logBox.width).toBeGreaterThan(430);
    // The conversation header is one compact row: name, state, AI | Operator.
    const header = page.getByTestId('conversation-header');
    expect((await header.boundingBox())!.height).toBeLessThan(52);
    // The composer tools share one row: suggest and quick replies side by side.
    const ask = (await page.getByTestId('suggest-ask').boundingBox())!;
    const quick = (await page.getByTestId('quick-reply-select').boundingBox())!;
    expect(
      Math.abs(ask.y + ask.height / 2 - (quick.y + quick.height / 2)),
    ).toBeLessThan(8);
    const one = (await input.boundingBox())!.height;
    expect(one).toBeLessThan(60);
    // The box grows with a long text, and shrinks back when it is sent away.
    await input.fill('line\n'.repeat(4) + 'end');
    await expect
      .poll(async () => (await input.boundingBox())!.height)
      .toBeGreaterThan(one + 40);
    await input.fill('');
    await expect
      .poll(async () => (await input.boundingBox())!.height)
      .toBeLessThan(60);
  } finally {
    await context.close();
  }
});

test('the compact list has no accessibility violations and fits a phone in en, ru and uz-Latn', async ({
  browser,
}) => {
  const f = fixtures();
  newHandover(f.a.tenantId, `Compact a11y ${Date.now()}`);
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
      await page.goto('/inbox');
      await expect(page.getByTestId('conversation-item').first()).toBeVisible();
      await page.getByTestId('inbox-filters-toggle').click();
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
