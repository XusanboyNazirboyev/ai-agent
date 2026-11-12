import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  consoleSession,
  findOverflow,
  fixtures,
  newHandover,
  newSession,
} from './helpers';

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
  // A toast or dialog still fading in has partial opacity, which reads as a
  // contrast failure; audit the settled page.
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running'),
  );
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
      const scopes = page.getByRole('tab');
      await expect(scopes).toHaveCount(3);
      const labels =
        language === 'ru'
          ? ['Все', 'Ожидают', 'Закрытые']
          : language === 'uz-Latn'
            ? ['Hammasi', 'Kutayotganlar', 'Yopilgan']
            : ['All', 'Waiting', 'Closed'];
      for (const [index, label] of labels.entries()) {
        await expect(scopes.nth(index)).toContainText(label);
      }
      await expect(scopes.nth(0)).toHaveAttribute('aria-selected', 'true');
      await audit(page, `list ${scheme} ${language} ${viewport.width}`);

      await page
        .getByTestId('conversation-item')
        .filter({ hasText: handover.contactName })
        .click();
      await expect(page.getByTestId('conversation-view')).toBeVisible();
      await audit(page, `conversation ${scheme} ${language} ${viewport.width}`);

      if (viewport.width < 1280) {
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

test.describe('leads, settings and status pages', () => {
  for (const [scheme, language, viewport] of [
    ['light', 'en', { width: 1280, height: 800 }],
    ['dark', 'en', { width: 1280, height: 800 }],
    ['light', 'ru', { width: 1280, height: 800 }],
    ['light', 'uz-Latn', { width: 375, height: 667 }],
    ['dark', 'en', { width: 375, height: 667 }],
  ] as const) {
    test(`have no violations (${scheme}, ${language}, ${viewport.width}px)`, async ({
      browser,
    }) => {
      const f = fixtures();
      const { page, context } = await newSession(
        browser,
        f.a.operators.op1.email,
        { viewport, colorScheme: scheme },
      );
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await page.goto('/leads?view=funnel');
      await expect(page.getByTestId('lead-column-NEW')).toBeAttached();
      await audit(page, `leads ${scheme} ${language} ${viewport.width}`);
      for (const path of [
        '/leads?view=list',
        '/more',
        '/settings/bot',
        '/knowledge',
        '/settings/pipeline',
        '/settings/crm',
        '/analytics',
      ]) {
        await page.goto(path);
        await expect(page.locator('#app-main [role="region"]')).toBeVisible();
        await audit(page, `${path} ${scheme} ${language} ${viewport.width}`);
      }
      await page.goto('/settings/channels');
      await expect(page.getByTestId('channel-account').first()).toBeVisible();
      await audit(page, `channels ${scheme} ${language} ${viewport.width}`);
      await page.goto('/settings');
      await expect(page.getByRole('radiogroup')).toBeVisible();
      await audit(page, `settings ${scheme} ${language} ${viewport.width}`);
      await page.goto('/no-such-page');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await audit(page, `not found ${scheme} ${language} ${viewport.width}`);
      await context.close();
    });
  }
});

test('the theme choice in settings is applied and remembered', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('radio', { name: 'System' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/u);
  await context.close();
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

  const all = page.getByRole('tab', { name: /^All/u });
  await all.focus();
  await page.keyboard.press('ArrowRight');
  const waiting = page.getByRole('tab', { name: /^Waiting/u });
  await expect(waiting).toHaveAttribute('aria-selected', 'true');
  await expect(waiting).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Closed' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /^All/u })).toBeFocused();
  // Only the selected tab is in the tab order.
  await expect(page.getByRole('tab', { name: 'Closed' })).toHaveAttribute(
    'tabindex',
    '-1',
  );
  await context.close();
});

test('the question form and the assistant switch have no violations', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
  );
  await page.goto('/settings/bot');
  await expect(page.getByTestId('bot-account')).toBeVisible();
  await audit(page, 'bot page as admin');
  await page.goto('/knowledge');
  await page.getByTestId('faq-add').click();
  await expect(page.getByTestId('faq-dialog')).toBeVisible();
  await audit(page, 'faq form');
  await page.getByTestId('faq-cancel').click();
  await page.getByTestId('knowledge-tab-documents').click();
  await page.getByTestId('document-upload').click();
  await expect(page.getByTestId('document-dialog')).toBeVisible();
  await audit(page, 'document form');
  await page.getByTestId('document-cancel').click();
  await page.getByTestId('knowledge-tab-faq').click();
  await page.getByTestId('faq-import').click();
  await expect(page.getByTestId('faq-import-dialog')).toBeVisible();
  await page.getByTestId('faq-import-file').setInputFiles({
    name: 'a.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('question,answer\nIs it free?,No.\n'),
  });
  await expect(page.getByTestId('faq-import-summary')).toBeVisible();
  await audit(page, 'faq import dialog');
  await context.close();
});

test('the channels page with controls and the connect dialog have no violations', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
  );
  await page.goto('/settings/channels');
  await expect(page.getByTestId('connect-telegram')).toBeVisible();
  await audit(page, 'channels as admin');
  await page.getByTestId('connect-telegram').click();
  await expect(page.getByTestId('telegram-connect-dialog')).toBeVisible();
  await audit(page, 'connect dialog');
  await page.getByTestId('connect-cancel').click();
  await page.locator('details summary').first().click();
  await audit(page, 'instagram guide open');
  await context.close();
});

test.describe('platform console and the ADR 047 tenant pages', () => {
  for (const [scheme, language, viewport] of [
    ['light', 'en', { width: 1280, height: 800 }],
    ['dark', 'en', { width: 1280, height: 800 }],
    ['light', 'ru', { width: 1280, height: 800 }],
    ['light', 'uz-Latn', { width: 1280, height: 800 }],
    ['light', 'uz-Latn', { width: 320, height: 640 }],
    ['dark', 'ru', { width: 320, height: 640 }],
  ] as const) {
    const label = `${scheme}, ${language}, ${viewport.width}px`;

    async function check(page: Page, name: string): Promise<void> {
      await audit(page, `${name} ${label}`);
      if (viewport.width <= 375)
        expect(await findOverflow(page), `${name} ${label}`).toEqual([]);
    }

    test(`console screens have no violations (${label})`, async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const f = fixtures();
      const signedOut = await browser.newContext({
        baseURL: 'http://127.0.0.1:3010',
        colorScheme: scheme,
        viewport,
      });
      const anonymous = await signedOut.newPage();
      await anonymous.goto('/console/login');
      await anonymous
        .getByLabel(/^(Language|Язык|Til)$/u)
        .selectOption(language);
      await check(anonymous, 'console login');
      await anonymous.goto('/console/invite/not-a-real-token-000000');
      await expect(anonymous.getByTestId('invite-accept')).toBeVisible();
      await check(anonymous, 'console invite');
      await signedOut.close();

      const { page, context } = await consoleSession(
        browser,
        f.platform.owner.email,
        { viewport, colorScheme: scheme },
      );
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await expect(page.getByTestId('tenant-row').first()).toBeVisible();
      await check(page, 'console customers');
      await page.getByTestId('new-customer').click();
      await expect(page.getByTestId('new-customer-dialog')).toBeVisible();
      await check(page, 'new customer dialog');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('new-customer-dialog')).toBeHidden();
      await expect(page.getByTestId('new-customer')).toBeFocused();

      await page.goto(`/console/tenants/${f.a.tenantId}`);
      await expect(page.getByTestId('subscription-card')).toBeVisible();
      await expect(page.getByTestId('payments-card')).toBeVisible();
      await check(page, 'console customer');
      await page.getByTestId('tenant-suspend').click();
      const reason = page.getByTestId('status-dialog');
      await expect(reason).toBeVisible();
      await check(page, 'reason dialog');
      await reason.getByTestId('reason-cancel').click();
      await expect(page.getByTestId('tenant-suspend')).toBeFocused();
      await page.getByTestId('payment-record').click();
      await expect(page.getByTestId('payment-dialog')).toBeVisible();
      await page.getByTestId('payment-amount').fill('150 000');
      await check(page, 'payment dialog');
      await page.keyboard.press('Escape');
      await page.getByTestId('tenant-invite').click();
      await expect(page.getByTestId('tenant-invite-dialog')).toBeVisible();
      await check(page, 'invite dialog');
      await page.keyboard.press('Escape');

      for (const [path, row] of [
        ['/console/plans', 'plan-row'],
        ['/console/admins', 'admin-row'],
      ] as const) {
        await page.goto(path);
        await expect(page.getByTestId(row).first()).toBeVisible();
        await check(page, path);
      }
      await page.goto('/console/plans');
      await page.getByTestId('plan-new').click();
      await expect(page.getByTestId('plan-dialog')).toBeVisible();
      await check(page, 'plan dialog');
      await page.keyboard.press('Escape');
      await page.goto('/console/audit');
      await expect(page.getByTestId('audit-row').first()).toBeVisible();
      await check(page, 'console audit');
      await context.close();
    });

    test(`team, subscription, invite and banner have no violations (${label})`, async ({
      browser,
    }) => {
      const f = fixtures();
      const signedOut = await browser.newContext({
        baseURL: 'http://127.0.0.1:3010',
        colorScheme: scheme,
        viewport,
      });
      const anonymous = await signedOut.newPage();
      await anonymous.goto('/invite/not-a-real-token-000000');
      await anonymous
        .getByLabel(/^(Language|Язык|Til)$/u)
        .selectOption(language);
      await expect(anonymous.getByTestId('invite-invalid')).toBeVisible();
      await check(anonymous, 'invite invalid');
      await signedOut.close();

      const admin = await newSession(browser, f.a.operators.admin.email, {
        viewport,
        colorScheme: scheme,
      });
      await admin.page
        .getByLabel(/^(Language|Язык|Til)$/u)
        .selectOption(language);
      await admin.page.goto('/settings/team');
      await expect(admin.page.getByTestId('team-member').first()).toBeVisible();
      await check(admin.page, 'team');
      await admin.page.getByTestId('team-invite').click();
      await expect(admin.page.getByTestId('team-invite-dialog')).toBeVisible();
      await check(admin.page, 'team invite dialog');
      await admin.page.keyboard.press('Escape');
      await expect(admin.page.getByTestId('team-invite')).toBeFocused();
      await admin.page.goto('/settings/subscription');
      await expect(admin.page.getByTestId('own-none')).toBeVisible();
      await check(admin.page, 'subscription');
      await admin.context.close();

      const expired = await newSession(browser, f.expired.owner.email, {
        viewport,
        colorScheme: scheme,
      });
      await expired.page
        .getByLabel(/^(Language|Язык|Til)$/u)
        .selectOption(language);
      await expect(expired.page.getByTestId('access-banner')).toBeVisible();
      await check(expired.page, 'expired banner');
      await expired.context.close();
    });
  }
});

test.describe('people, person card, merge/erase, and fields (P1.1/P1.5)', () => {
  for (const language of ['en', 'ru', 'uz-Latn'] as const) {
    test(`people list, duplicates tab and empty state have no violations (${language})`, async ({
      browser,
    }) => {
      const f = fixtures();
      const { page, context } = await newSession(
        browser,
        f.a.operators.owner.email,
      );
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);

      await page.goto('/contacts', { waitUntil: 'networkidle' });
      await expect(page.getByTestId('person-item').first()).toBeVisible();
      await audit(page, `contacts list ${language}`);

      await page.getByTestId('people-tab-duplicates').click();
      // Seeded tenant A has shared-phone customers, so duplicates exist.
      await expect(page.getByTestId('duplicate-group').first()).toBeVisible();
      await audit(page, `contacts duplicates ${language}`);

      // Force an empty state by filtering to a tag that cannot exist.
      await page.getByTestId('people-tab-list').click();
      await page
        .getByLabel(/search by name or phone|поиск|qidir/i)
        .fill('__no_such_person_012__');
      await expect(
        page.getByText(
          /No person matches your search|Люди по запросу не найдены|So‘rov bo‘yicha odam topilmadi/i,
        ),
      ).toBeVisible();
      await audit(page, `contacts empty ${language}`);
      await context.close();
    });
  }

  test('person card as owner: duplicate banner, merge dialog, erase confirm, tag picker and custom field editors have no violations', async ({
    browser,
  }) => {
    const f = fixtures();
    const { page, context } = await newSession(
      browser,
      f.a.operators.owner.email,
    );

    // Prepare P1.5 definitions so the card shows tag picker and all field types.
    await page.goto('/settings/fields', { waitUntil: 'networkidle' });
    await page.getByTestId('tag-name-input').fill('A11y tag');
    await page.getByTestId('tag-create').click();
    await expect(
      page.getByTestId('tag-row').filter({ hasText: 'A11y tag' }),
    ).toBeVisible();

    const defs = [
      { label: 'A11y text', key: 'a11y_text', type: 'TEXT' },
      { label: 'A11y number', key: 'a11y_number', type: 'NUMBER' },
      { label: 'A11y date', key: 'a11y_date', type: 'DATE' },
      { label: 'A11y bool', key: 'a11y_bool', type: 'BOOLEAN' },
      {
        label: 'A11y select',
        key: 'a11y_select',
        type: 'SELECT',
        options: 'A\nB',
      },
    ];
    for (const def of defs) {
      await page.getByTestId('def-label-input').fill(def.label);
      await page.getByTestId('def-key-input').fill(def.key);
      await page.getByTestId('def-type-select').selectOption(def.type);
      if (def.options) {
        await page.getByTestId('def-options-input').fill(def.options);
      }
      await page.getByTestId('def-create').click();
      await expect(
        page.getByTestId('def-row').filter({ hasText: def.label }),
      ).toBeVisible();
    }

    await page.goto('/contacts', { waitUntil: 'networkidle' });
    const row = page
      .getByTestId('person-item')
      .filter({ hasText: f.a.conversations[0].contactName });
    await row.getByTestId('person-open-card').click();
    await expect(page.getByTestId('person-header')).toBeVisible();
    await expect(page.getByTestId('person-duplicates')).toBeVisible();
    await audit(page, 'person card with duplicates banner');

    // Tag picker open.
    await page.getByTestId('person-tag-add').click();
    await expect(page.getByTestId('person-tag-select')).toBeVisible();
    await audit(page, 'person card tag picker open');

    // Custom field editors for all types are present.
    await expect(
      page.getByTestId('person-custom-field').filter({ hasText: 'A11y text' }),
    ).toBeVisible();
    await expect(
      page
        .getByTestId('person-custom-field')
        .filter({ hasText: 'A11y number' }),
    ).toBeVisible();
    await expect(
      page.getByTestId('person-custom-field').filter({ hasText: 'A11y date' }),
    ).toBeVisible();
    await expect(
      page.getByTestId('person-custom-field').filter({ hasText: 'A11y bool' }),
    ).toBeVisible();
    await expect(
      page
        .getByTestId('person-custom-field')
        .filter({ hasText: 'A11y select' }),
    ).toBeVisible();
    await audit(page, 'person card custom field editors');

    // Merge dialog open.
    await page.getByTestId('merge-candidate-into-person').first().click();
    await expect(page.getByTestId('merge-dialog')).toBeVisible();
    await audit(page, 'merge dialog open');
    await page.getByTestId('merge-cancel').click();
    await expect(page.getByTestId('merge-dialog')).toBeHidden();

    // Person erase confirm open.
    await page.getByTestId('person-erase').click();
    const eraseDialog = page
      .getByTestId('person-header')
      .getByTestId('confirm-dialog');
    await expect(eraseDialog).toBeVisible();
    await audit(page, 'person erase confirm open');
    await eraseDialog.getByTestId('confirm-cancel').click();
    await expect(eraseDialog).toBeHidden();
    await context.close();
  });

  for (const language of ['en', 'ru', 'uz-Latn'] as const) {
    test(`settings fields as owner and operator have no violations (${language})`, async ({
      browser,
    }) => {
      const f = fixtures();
      const owner = await newSession(browser, f.a.operators.owner.email);
      await owner.page
        .getByLabel(/^(Language|Язык|Til)$/u)
        .selectOption(language);
      await owner.page.goto('/settings/fields', { waitUntil: 'networkidle' });
      await expect(owner.page.getByTestId('tag-name-input')).toBeVisible();

      // Create a tag and all field types for the owner audit.
      await owner.page.getByTestId('tag-name-input').fill(`Tag ${language}`);
      await owner.page.getByTestId('tag-create').click();
      await expect(
        owner.page
          .getByTestId('tag-row')
          .filter({ hasText: `Tag ${language}` }),
      ).toBeVisible();

      for (const [type, label, key] of [
        ['TEXT', `T ${language}`, `t_${language.slice(0, 2)}`],
        ['NUMBER', `N ${language}`, `n_${language.slice(0, 2)}`],
        ['DATE', `D ${language}`, `d_${language.slice(0, 2)}`],
        ['BOOLEAN', `B ${language}`, `b_${language.slice(0, 2)}`],
        ['SELECT', `S ${language}`, `s_${language.slice(0, 2)}`],
      ] as const) {
        await owner.page.getByTestId('def-label-input').fill(label);
        await owner.page
          .getByTestId('def-key-input')
          .fill(key.replace(/-/g, '_'));
        await owner.page.getByTestId('def-type-select').selectOption(type);
        if (type === 'SELECT') {
          await owner.page.getByTestId('def-options-input').fill('One\nTwo');
        }
        await owner.page.getByTestId('def-create').click();
        await expect(
          owner.page.getByTestId('def-row').filter({ hasText: label }),
        ).toBeVisible();
      }
      await audit(owner.page, `settings fields owner ${language}`);
      await owner.context.close();

      const op = await newSession(browser, f.a.operators.op1.email);
      await op.page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await op.page.goto('/settings/fields', { waitUntil: 'networkidle' });
      await expect(op.page.getByRole('region')).toBeVisible();
      await expect(op.page.getByTestId('tag-name-input')).toHaveCount(0);
      await expect(op.page.getByTestId('def-label-input')).toHaveCount(0);
      await audit(op.page, `settings fields operator read-only ${language}`);
      await op.context.close();
    });
  }

  test('keyboard: merge dialog focus trap and Escape returns focus; confirm dialogs Escape/cancel return focus', async ({
    browser,
  }) => {
    const f = fixtures();
    const { page, context } = await newSession(
      browser,
      f.a.operators.owner.email,
    );
    await page.goto('/contacts', { waitUntil: 'networkidle' });
    const row = page
      .getByTestId('person-item')
      .filter({ hasText: f.a.conversations[0].contactName });
    await row.getByTestId('person-open-card').click();
    await expect(page.getByTestId('person-duplicates')).toBeVisible();

    const opener = page.getByTestId('merge-candidate-into-person').first();
    await opener.click();
    const merge = page.getByTestId('merge-dialog');
    await expect(merge).toBeVisible();
    // Native <dialog> traps focus; Escape closes and returns focus to opener.
    await page.keyboard.press('Tab');
    await expect(merge.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(merge).toBeHidden();
    await expect(opener).toBeFocused();

    const eraseOpener = page.getByTestId('person-erase');
    await eraseOpener.click();
    const erase = page
      .getByTestId('person-header')
      .getByTestId('confirm-dialog');
    await expect(erase).toBeVisible();
    await expect(erase.getByTestId('confirm-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(erase).toBeHidden();
    await expect(eraseOpener).toBeFocused();

    await eraseOpener.click();
    await expect(erase).toBeVisible();
    await erase.getByTestId('confirm-cancel').click();
    await expect(erase).toBeHidden();
    await expect(eraseOpener).toBeFocused();
    await context.close();
  });

  test('keyboard: tag picker and person tag add/remove are reachable', async ({
    browser,
  }) => {
    const f = fixtures();
    const { page, context } = await newSession(
      browser,
      f.a.operators.owner.email,
    );
    await page.goto('/settings/fields', { waitUntil: 'networkidle' });
    await page.getByTestId('tag-name-input').fill('KB tag');
    await page.getByTestId('tag-create').click();
    await expect(
      page.getByTestId('tag-row').filter({ hasText: 'KB tag' }),
    ).toBeVisible();

    await page.goto('/contacts', { waitUntil: 'networkidle' });
    await page
      .getByTestId('person-item')
      .first()
      .getByTestId('person-open-card')
      .click();
    await expect(page.getByTestId('person-tags')).toBeVisible();

    const add = page.getByTestId('person-tag-add');
    await add.focus();
    await expect(add).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('person-tag-select')).toBeVisible();
    await page
      .getByTestId('person-tag-select')
      .selectOption({ label: 'KB tag' });
    await expect(
      page.getByTestId('person-tag-chip').filter({ hasText: 'KB tag' }),
    ).toBeVisible();

    const remove = page.getByTestId('person-tag-remove').first();
    await remove.focus();
    await expect(remove).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      page.getByTestId('person-tag-chip').filter({ hasText: 'KB tag' }),
    ).toHaveCount(0);
    await context.close();
  });
});

test.describe('mobile 320px overflow: contacts and fields (P1.1/P1.5)', () => {
  for (const language of ['ru', 'uz-Latn'] as const) {
    test(`contacts list, person card and settings fields have no overflow (${language}, 320px)`, async ({
      browser,
    }) => {
      const f = fixtures();
      const { page, context } = await newSession(
        browser,
        f.a.operators.owner.email,
        { viewport: { width: 320, height: 640 } },
      );
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);

      await page.goto('/contacts', { waitUntil: 'networkidle' });
      await expect(page.getByTestId('person-item').first()).toBeVisible();
      expect(await findOverflow(page), `/contacts ${language} 320`).toEqual([]);

      await page.getByTestId('people-tab-duplicates').click();
      await expect(page.getByTestId('duplicate-group').first()).toBeVisible();
      expect(
        await findOverflow(page),
        `/contacts duplicates ${language} 320`,
      ).toEqual([]);

      await page.getByTestId('people-tab-list').click();
      await page
        .getByTestId('person-item')
        .first()
        .getByTestId('person-open-card')
        .click();
      await expect(page.getByTestId('person-header')).toBeVisible();
      expect(await findOverflow(page), `/contacts/:id ${language} 320`).toEqual(
        [],
      );

      await page.goto('/settings/fields', { waitUntil: 'networkidle' });
      await expect(page.getByRole('region')).toBeVisible();
      expect(
        await findOverflow(page),
        `/settings/fields ${language} 320`,
      ).toEqual([]);
      await context.close();
    });
  }
});
