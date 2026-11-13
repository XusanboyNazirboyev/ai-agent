import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { findOverflow, fixtures, newSession } from './helpers';

const TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
  'best-practice',
];

async function audit(page: Page, label: string): Promise<void> {
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

test('dialog opens from lead-add, focus on name, Escape closes without request, focus returns', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.b.operators.op1.email);
  await page.goto('/leads?view=funnel');

  const addButton = page.getByTestId('lead-add');
  await expect(addButton).toBeVisible();
  await addButton.click();
  const dialog = page.getByTestId('lead-add-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('lead-add-name')).toBeFocused();

  let postCount = 0;
  page.on('request', (request) => {
    if (
      request.url().includes('/api/v1/leads') &&
      request.method() === 'POST'
    ) {
      postCount += 1;
    }
  });

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(addButton).toBeFocused();
  expect(postCount).toBe(0);

  await context.close();
});

test('validation: submit is disabled until the name is filled; no amount field (hidden by owner decision)', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.b.operators.op1.email);
  await page.goto('/leads?view=funnel');

  await page.getByTestId('lead-add').click();
  const dialog = page.getByTestId('lead-add-dialog');
  await expect(dialog).toBeVisible();

  const submit = page.getByTestId('lead-add-submit');
  await expect(submit).toBeDisabled();
  await page.getByTestId('lead-add-name').fill('   ');
  await expect(submit).toBeDisabled();
  await page.getByTestId('lead-add-name').fill('Walk-in lead');
  await expect(submit).toBeEnabled();
  await expect(dialog.getByTestId('lead-add-amount')).toHaveCount(0);
  await expect(dialog.getByTestId('lead-add-currency')).toHaveCount(0);

  await context.close();
});

test('server error 400: inline alert visible, dialog stays open, name retained', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.b.operators.op1.email);
  await page.goto('/leads?view=funnel');

  await page.route('**/api/v1/leads', (route) => {
    void route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        statusCode: 400,
        message: 'x',
        code: 'INVALID_VALUE',
        i18nKey: 'errors.INVALID_VALUE',
      }),
    });
  });

  await page.getByTestId('lead-add').click();
  const dialog = page.getByTestId('lead-add-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('lead-add-name').fill('Failed lead');

  await page.getByTestId('lead-add-submit').click();

  // Inside the dialog: the page may show other alerts (a toast) on CI.
  const alert = dialog.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('lead-add-name')).toHaveValue('Failed lead');

  await context.close();
});

test('request body shape: name trimmed, pipelineId and stageId present, no amount, no empty phone/note/source', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.b.operators.op1.email);
  await page.goto('/leads?view=funnel');

  let capturedBody: string | null = null;
  await page.route('**/api/v1/leads', async (route) => {
    capturedBody = (await route.request().postData()) ?? null;
    await route.abort();
  });

  await page.getByTestId('lead-add').click();
  const dialog = page.getByTestId('lead-add-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('lead-add-name').fill('  Body lead  ');
  await page.getByTestId('lead-add-submit').click();

  await expect.poll(() => capturedBody).not.toBeNull();
  const body = JSON.parse(capturedBody!);
  expect(body.name).toBe('Body lead');
  expect(body.pipelineId).toBeTruthy();
  expect(body.stageId).toBeTruthy();
  expect(body.phone).toBeUndefined();
  expect(body.note).toBeUndefined();
  expect(body.source).toBeUndefined();
  expect(body.amount).toBeUndefined();
  expect(body.currency).toBeUndefined();

  await context.close();
});

test('viewer has no lead-add and no lead-column-add; operator has both', async ({
  browser,
}) => {
  const f = fixtures();

  const { page: viewerPage, context: viewerCtx } = await newSession(
    browser,
    f.a.operators.viewer.email,
  );
  await viewerPage.goto('/leads?view=funnel');
  await expect(viewerPage.getByTestId('lead-add')).toHaveCount(0);
  await expect(viewerPage.getByTestId('lead-column-add')).toHaveCount(0);
  await viewerCtx.close();

  const { page: opPage, context: opCtx } = await newSession(
    browser,
    f.b.operators.op1.email,
  );
  await opPage.goto('/leads?view=funnel');
  await expect(opPage.getByTestId('lead-add')).toBeVisible();
  await expect(opPage.getByTestId('lead-column-add').first()).toBeVisible();
  await opCtx.close();
});

test('axe on open dialog as ADMIN of tenant A (nothing is created): en, ru, uz-Latn at 1280 and 375px', async ({
  browser,
}) => {
  const f = fixtures();
  const languages = ['en', 'ru', 'uz-Latn'] as const;

  for (const language of languages) {
    for (const width of [1280, 375] as const) {
      const { page, context } = await newSession(
        browser,
        f.a.operators.admin.email,
        { viewport: { width, height: width === 375 ? 667 : 800 } },
      );
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await page.goto('/leads?view=funnel');
      await page.getByTestId('lead-add').click();
      await expect(page.getByTestId('lead-add-dialog')).toBeVisible();
      await audit(page, `dialog ${language} ${width}px`);
      await context.close();
    }
  }
});

test('overflow with dialog open: empty findOverflow at 320/375/768 in ru and uz-Latn; submit in viewport at 320px', async ({
  browser,
}) => {
  const f = fixtures();
  const languages = ['ru', 'uz-Latn'] as const;

  for (const language of languages) {
    for (const width of [320, 375, 768] as const) {
      const { page, context } = await newSession(
        browser,
        f.a.operators.admin.email,
        { viewport: { width, height: width === 320 ? 560 : 640 } },
      );
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await page.goto('/leads?view=funnel');
      await page.getByTestId('lead-add').click();
      await expect(page.getByTestId('lead-add-dialog')).toBeVisible();

      const problems = await findOverflow(page);
      expect(problems, `overflow ${language} ${width}px`).toEqual([]);

      if (width === 320) {
        const submit = page.getByTestId('lead-add-submit');
        await expect(submit).toBeVisible();
        // The dialog scrolls inside itself (max-h, overflow-y-auto): bring the
        // button into view first, then it must lie inside the window.
        await submit.scrollIntoViewIfNeeded();
        const box = await submit.boundingBox();
        expect(box).not.toBeNull();
        const viewport = page.viewportSize()!;
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
      }
      await context.close();
    }
  }
});

test('accordion on settings/pipeline as OWNER of tenant A: aria-expanded/controls, Enter and Space toggle, collapse state, overflow', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
    { viewport: { width: 320, height: 640 } },
  );
  await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('ru');
  await page.goto('/settings/pipeline');

  await expect(page.getByTestId('pipelines-list')).toBeVisible();
  const toggles = page.getByTestId('pipeline-toggle');
  await expect(toggles.first()).toBeVisible();
  const count = await toggles.count();
  expect(count).toBeGreaterThan(0);

  let oneCollapsed = false;
  let oneExpanded = false;

  for (let i = 0; i < count; i++) {
    const toggle = toggles.nth(i);
    await expect(toggle).toHaveAttribute('aria-expanded');
    await expect(toggle).toHaveAttribute('aria-controls');
    const expanded = await toggle.getAttribute('aria-expanded');
    const controlsId = await toggle.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();

    if (expanded === 'true') {
      oneExpanded = true;
      await expect(page.locator(`[id="${controlsId!}"]`)).toBeAttached();
    } else {
      oneCollapsed = true;
      await expect(page.locator(`[id="${controlsId!}"]`)).toHaveCount(0);
    }
  }

  if (count >= 2) {
    expect(oneCollapsed).toBe(true);
  } else {
    expect(oneExpanded).toBe(true);
  }

  await toggles.first().focus();
  await page.keyboard.press('Enter');
  await expect(toggles.first()).toHaveAttribute(
    'aria-expanded',
    oneExpanded ? 'false' : 'true',
  );

  await page.keyboard.press(' ');
  await expect(toggles.first()).toHaveAttribute(
    'aria-expanded',
    oneExpanded ? 'true' : 'false',
  );

  await context.close();

  for (const language of ['ru', 'uz-Latn'] as const) {
    for (const expanded of [false, true] as const) {
      const { page: ovPage, context: ovCtx } = await newSession(
        browser,
        f.a.operators.owner.email,
        { viewport: { width: 320, height: 640 } },
      );
      await ovPage.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await ovPage.goto('/settings/pipeline');

      const ovToggles = ovPage.getByTestId('pipeline-toggle');
      const ovCount = await ovToggles.count();
      for (let i = 0; i < ovCount; i++) {
        const ovExpanded = await ovToggles.nth(i).getAttribute('aria-expanded');
        const wantExpanded = expanded;
        if ((ovExpanded === 'true') !== wantExpanded) {
          await ovToggles.nth(i).press('Enter');
        }
      }

      const ovProblems = await findOverflow(ovPage);
      expect(
        ovProblems,
        `accordion overflow ${language} expanded=${expanded} 320px`,
      ).toEqual([]);
      await ovCtx.close();
    }
  }
});
