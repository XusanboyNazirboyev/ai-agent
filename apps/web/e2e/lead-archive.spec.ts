import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixtures, newSession } from './helpers';

// Archive, restore and delete for good (ADR 062). The lead is created by the
// test and deleted at the end: tenant A's shared board is left as it was.

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

const card = (page: Page, name: string): Locator =>
  page.getByTestId('lead-card').filter({ hasText: name });

test('an admin archives and restores a lead; only the owner deletes it for good', async ({
  browser,
}) => {
  const f = fixtures();
  const name = `Archive e2e ${Date.now()}`;
  const admin = await newSession(browser, f.a.operators.admin.email);
  try {
    await admin.page.goto('/leads?view=funnel');
    await expect(admin.page.getByTestId('lead-column-NEW')).toBeVisible();
    await addLead(admin.page, name);
    await admin.page.reload();
    await expect(card(admin.page, name)).toBeVisible();

    // Archive from the panel: it asks first, then the lead leaves the board.
    await card(admin.page, name).getByTestId('lead-card-open').click();
    await admin.page.getByTestId('lead-archive').click();
    await admin.page.getByTestId('confirm-accept').click();
    await expect(admin.page.getByTestId('lead-panel')).toBeHidden();
    await expect(card(admin.page, name)).toHaveCount(0);

    // The archive lists it; an admin can restore but not delete for good.
    await admin.page.getByTestId('leads-view-archive').click();
    const row = admin.page
      .getByTestId('leads-archive-row')
      .filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('lead-delete-forever')).toHaveCount(0);
    await row.getByTestId('lead-restore').click();
    await expect(row).toHaveCount(0);
    await admin.page
      .getByTestId('leads-view-toggle')
      .getByRole('button')
      .first()
      .click();
    await expect(card(admin.page, name)).toBeVisible();

    // Archive again and let the owner delete it for good.
    await card(admin.page, name).getByTestId('lead-card-open').click();
    await admin.page.getByTestId('lead-archive').click();
    await admin.page.getByTestId('confirm-accept').click();
    await expect(card(admin.page, name)).toHaveCount(0);
  } finally {
    await admin.context.close();
  }

  const owner = await newSession(browser, f.a.operators.owner.email);
  try {
    await owner.page.goto('/leads?view=funnel');
    await owner.page.getByTestId('leads-view-archive').click();
    const row = owner.page
      .getByTestId('leads-archive-row')
      .filter({ hasText: name });
    await expect(row).toBeVisible();
    await row.getByTestId('lead-delete-forever').click();
    await owner.page.getByTestId('confirm-accept').click();
    await expect(row).toHaveCount(0);
    // Gone for good: neither the board nor the archive holds it.
    await owner.page.reload();
    await owner.page.getByTestId('leads-view-archive').click();
    await expect(
      owner.page.getByTestId('leads-archive-row').filter({ hasText: name }),
    ).toHaveCount(0);
  } finally {
    await owner.context.close();
  }
});

test('an operator cannot archive and has no archive view', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  await page.goto('/leads?view=funnel');
  await expect(page.getByTestId('lead-column-NEW')).toBeVisible();
  await expect(page.getByTestId('leads-view-archive')).toHaveCount(0);
  await card(page, f.a.conversations[0]!.contactName)
    .getByTestId('lead-card-open')
    .click();
  await expect(page.getByTestId('lead-panel')).toBeVisible();
  await expect(page.getByTestId('lead-archive')).toHaveCount(0);
  await context.close();
});
