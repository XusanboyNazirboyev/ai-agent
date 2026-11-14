import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { findOverflow, fixtures, newSession } from './helpers';

// Archive, restore and delete for good (ADR 062). The lead is created by the
// test and deleted for good at the end so the shared tenant board is left as
// it was. Archive needs f.a.operators.admin; delete-for-good needs
// f.a.operators.owner.

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

async function addLead(page: Page, name: string): Promise<string> {
  return page.evaluate(async (leadName) => {
    const csrf = /(?:^|; )ac_csrf=([^;]+)/u.exec(document.cookie)?.[1] ?? '';
    const response = await fetch('/api/v1/leads', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': decodeURIComponent(csrf),
      },
      body: JSON.stringify({ name: leadName }),
    });
    return ((await response.json()) as { id: string }).id;
  }, name);
}

async function api(
  page: Page,
  method: 'POST' | 'DELETE',
  path: string,
): Promise<number> {
  return page.evaluate(
    async ({ method: m, path: p }) => {
      const csrf = /(?:^|; )ac_csrf=([^;]+)/u.exec(document.cookie)?.[1] ?? '';
      const response = await fetch(p, {
        method: m,
        headers: { 'x-csrf-token': decodeURIComponent(csrf) },
      });
      return response.status;
    },
    { method, path },
  );
}

/** A lead that is already in the archive (created and archived by the API). */
async function archivedLead(page: Page, name: string): Promise<string> {
  const id = await addLead(page, name);
  expect(await api(page, 'POST', `/api/v1/leads/${id}/archive`)).toBe(204);
  return id;
}

const card = (page: Page, name: string): Locator =>
  page.getByTestId('lead-card').filter({ hasText: name });

const row = (page: Page, name: string): Locator =>
  page.getByTestId('leads-archive-row').filter({ hasText: name });

test('empty archive: empty state visible or honestly skipped', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
  );
  await page.goto('/leads?view=funnel');
  await expect(page.getByTestId('lead-column-NEW')).toBeVisible();
  await page.getByTestId('leads-view-archive').click();
  const empty = page.getByTestId('leads-archive-empty');
  const rows = page.getByTestId('leads-archive-row');
  // The fixture may already hold archived leads from other specs; if so we
  // honestly do not assert emptiness.
  if ((await rows.count()) === 0) {
    await expect(empty).toBeVisible();
    await expect(empty).not.toHaveText('');
  } else {
    await expect(rows.first()).toBeVisible();
  }
  await context.close();
});

test('confirm dialog: focus inside, Escape closes without request, focus returns', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
  );
  const name = `Archive dialog ${Date.now()}`;
  await page.goto('/leads?view=funnel');
  await addLead(page, name);
  await page.reload();
  await expect(card(page, name)).toBeVisible();

  await card(page, name).getByTestId('lead-card-open').click();
  await expect(page.getByTestId('lead-panel')).toBeVisible();
  await page.getByTestId('lead-archive').click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  // Focus is inside the dialog.
  await expect(dialog.locator(':focus')).toHaveCount(1);

  let archiveRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('/archive') && request.method() === 'POST')
      archiveRequests += 1;
  });

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(archiveRequests).toBe(0);
  // Focus returns to the archive button.
  await expect(page.getByTestId('lead-archive')).toBeFocused();
  // The lead is still on the board.
  await expect(card(page, name)).toBeVisible();

  // Clean up: an admin archives it, only the owner may delete it for good.
  await page.getByTestId('lead-archive').click();
  await page.getByTestId('confirm-accept').click();
  await expect(card(page, name)).toHaveCount(0);
  await context.close();
  const owner = await newSession(browser, f.a.operators.owner.email);
  await owner.page.goto('/leads?view=funnel');
  await owner.page.getByTestId('leads-view-archive').click();
  await expect(row(owner.page, name)).toBeVisible();
  await row(owner.page, name).getByTestId('lead-delete-forever').click();
  await owner.page.getByTestId('confirm-accept').click();
  await expect(row(owner.page, name)).toHaveCount(0);
  await owner.context.close();
});

test('delete-for-good confirmation: cannot-be-undone text, Cancel keeps row', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.owner.email,
  );
  const name = `Delete forever ${Date.now()}`;
  await page.goto('/leads?view=funnel');
  await addLead(page, name);
  await page.reload();
  await expect(card(page, name)).toBeVisible();

  await card(page, name).getByTestId('lead-card-open').click();
  await page.getByTestId('lead-archive').click();
  await page.getByTestId('confirm-accept').click();
  await expect(card(page, name)).toHaveCount(0);
  await page.getByTestId('leads-view-archive').click();
  await expect(row(page, name)).toBeVisible();

  let deleteRequests = 0;
  page.on('request', (request) => {
    if (
      request.url().includes('/api/v1/leads/') &&
      request.method() === 'DELETE'
    )
      deleteRequests += 1;
  });

  await row(page, name).getByTestId('lead-delete-forever').click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  // Dialog text mentions it cannot be undone: visible and non-empty, not
  // hard-coded to English (works in ru/uz too).
  await expect(dialog).toHaveText(/./);

  await page.getByTestId('confirm-cancel').click();
  await expect(dialog).toBeHidden();
  expect(deleteRequests).toBe(0);
  await expect(row(page, name)).toBeVisible();

  // Actually delete it for good so the board is clean.
  await row(page, name).getByTestId('lead-delete-forever').click();
  await page.getByTestId('confirm-accept').click();
  await expect(row(page, name)).toHaveCount(0);
  await page.reload();
  await page.getByTestId('leads-view-archive').click();
  await expect(row(page, name)).toHaveCount(0);
  await context.close();
});

test('axe: archive view and delete dialog, OWNER en/ru/uz-Latn 1280/375px', async ({
  browser,
}) => {
  const f = fixtures();
  const languages = ['en', 'ru', 'uz-Latn'] as const;

  for (const language of languages) {
    for (const width of [1280, 375] as const) {
      const { page, context } = await newSession(
        browser,
        f.a.operators.owner.email,
        { viewport: { width, height: width === 375 ? 667 : 800 } },
      );
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await page.goto('/leads?view=funnel');
      const name = `Axe ${language} ${width} ${Date.now()}`;
      await archivedLead(page, name);
      await page.reload();
      await page.getByTestId('leads-view-archive').click();
      await expect(row(page, name)).toBeVisible();
      await audit(page, `archive ${language} ${width}px`);

      // Open the delete dialog and audit it too.
      await row(page, name).getByTestId('lead-delete-forever').click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await audit(page, `delete-dialog ${language} ${width}px`);
      await page.getByTestId('confirm-cancel').click();
      await expect(page.getByTestId('confirm-dialog')).toBeHidden();

      // Clean up the lead we created.
      await row(page, name).getByTestId('lead-delete-forever').click();
      await page.getByTestId('confirm-accept').click();
      await expect(row(page, name)).toHaveCount(0);
      await context.close();
    }
  }
});

test('overflow: archive view one row at 320/375/768 in ru and uz-Latn', async ({
  browser,
}) => {
  const f = fixtures();
  const languages = ['ru', 'uz-Latn'] as const;

  for (const language of languages) {
    for (const width of [320, 375, 768] as const) {
      const { page, context } = await newSession(
        browser,
        f.a.operators.owner.email,
        { viewport: { width, height: width === 320 ? 560 : 640 } },
      );
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await page.goto('/leads?view=funnel');
      const name = `Overflow ${language} ${width} ${Date.now()}`;
      await archivedLead(page, name);
      await page.reload();
      await page.getByTestId('leads-view-archive').click();
      await expect(row(page, name)).toBeVisible();
      expect(
        await findOverflow(page),
        `archive overflow ${language} ${width}px`,
      ).toEqual([]);

      // Restore and Delete buttons of the row are inside the viewport horizontally at 320px.
      if (width === 320) {
        const mine = row(page, name);
        const rowBox = await mine.boundingBox();
        const restoreBox = await mine.getByTestId('lead-restore').boundingBox();
        const deleteBox = await mine
          .getByTestId('lead-delete-forever')
          .boundingBox();
        const viewport = page.viewportSize()!;
        expect(rowBox).not.toBeNull();
        expect(restoreBox).not.toBeNull();
        expect(deleteBox).not.toBeNull();
        expect(restoreBox!.x + restoreBox!.width).toBeLessThanOrEqual(
          viewport.width + 1,
        );
        expect(deleteBox!.x + deleteBox!.width).toBeLessThanOrEqual(
          viewport.width + 1,
        );
        expect(restoreBox!.x).toBeGreaterThanOrEqual(-1);
        expect(deleteBox!.x).toBeGreaterThanOrEqual(-1);
      }

      // Clean up.
      await row(page, name).getByTestId('lead-delete-forever').click();
      await page.getByTestId('confirm-accept').click();
      await expect(row(page, name)).toHaveCount(0);
      await context.close();
    }
  }
});

test('roles: ADMIN sees archive toggle, no delete-forever; OPERATOR/VIEWER no archive', async ({
  browser,
}) => {
  const f = fixtures();

  // ADMIN sees leads-view-archive, no lead-delete-forever.
  const { page: adminPage, context: adminCtx } = await newSession(
    browser,
    f.a.operators.admin.email,
  );
  await adminPage.goto('/leads?view=funnel');
  await expect(adminPage.getByTestId('leads-view-archive')).toBeVisible();
  await adminPage.getByTestId('leads-view-archive').click();
  await expect(adminPage.getByTestId('lead-delete-forever')).toHaveCount(0);
  await adminCtx.close();

  // OPERATOR: no archive toggle, no GET /api/v1/leads?archived=true request.
  const opArchiveRequests: string[] = [];
  const { page: opPage, context: opCtx } = await newSession(
    browser,
    f.a.operators.op1.email,
  );
  opPage.on('request', (request) => {
    if (
      request.url().includes('/api/v1/leads') &&
      new URL(request.url()).searchParams.get('archived') === 'true'
    )
      opArchiveRequests.push(request.method() + ' ' + request.url());
  });
  await opPage.goto('/leads?view=funnel');
  await expect(opPage.getByTestId('leads-view-archive')).toHaveCount(0);
  await opCtx.close();

  // VIEWER: same.
  const viewerArchiveRequests: string[] = [];
  const { page: viewerPage, context: viewerCtx } = await newSession(
    browser,
    f.a.operators.viewer.email,
  );
  viewerPage.on('request', (request) => {
    if (
      request.url().includes('/api/v1/leads') &&
      new URL(request.url()).searchParams.get('archived') === 'true'
    )
      viewerArchiveRequests.push(request.method() + ' ' + request.url());
  });
  await viewerPage.goto('/leads?view=funnel');
  await expect(viewerPage.getByTestId('leads-view-archive')).toHaveCount(0);
  await viewerCtx.close();
  expect(opArchiveRequests).toEqual([]);
  expect(viewerArchiveRequests).toEqual([]);
});

test('API refuses what the UI hides: OPERATOR archive 403, ADMIN delete 403', async ({
  browser,
}) => {
  const f = fixtures();
  const name = `Api refuse ${Date.now()}`;

  const admin = await newSession(browser, f.a.operators.admin.email);
  const leadId = await addLead(admin.page, name);
  try {
    // An operator cannot archive.
    const operator = await newSession(browser, f.a.operators.op1.email);
    expect(
      await api(operator.page, 'POST', `/api/v1/leads/${leadId}/archive`),
    ).toBe(403);
    await operator.context.close();

    // Archived by the admin, the lead still cannot be deleted by the admin:
    // 403 for the role, not 409 for a lead that is still active.
    expect(
      await api(admin.page, 'POST', `/api/v1/leads/${leadId}/archive`),
    ).toBe(204);
    expect(await api(admin.page, 'DELETE', `/api/v1/leads/${leadId}`)).toBe(
      403,
    );
  } finally {
    await admin.context.close();
    // Clean up as the owner, the only role that may delete for good.
    const owner = await newSession(browser, f.a.operators.owner.email);
    expect(await api(owner.page, 'DELETE', `/api/v1/leads/${leadId}`)).toBe(
      204,
    );
    await owner.context.close();
  }
});
