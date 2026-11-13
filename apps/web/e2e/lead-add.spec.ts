import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';

// A lead added by hand (ADR 061): the toolbar button and the "+" of a column.

test('an operator adds a lead from the toolbar and from a column', async ({
  browser,
}) => {
  // The second fixture tenant: the leads added here stay out of the shared
  // board that other specs count and move cards on.
  const f = fixtures();
  const { page, context } = await newSession(browser, f.b.operators.op1.email);
  await page.goto('/leads?view=funnel');
  await expect(page.getByTestId('lead-column-NEW')).toBeVisible();

  // Toolbar: lands in the first open column.
  const first = `Walk-in ${Date.now()}`;
  await page.getByTestId('lead-add').click();
  const dialog = page.getByTestId('lead-add-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('lead-add-submit')).toBeDisabled();
  await dialog.getByTestId('lead-add-name').fill(first);
  await dialog.getByTestId('lead-add-phone').fill('+998 90 555 44 33');
  await dialog.getByTestId('lead-add-amount').fill('1500.50');
  await dialog.getByTestId('lead-add-note').fill('Came to the office');
  await dialog.getByTestId('lead-add-submit').click();
  await expect(dialog).toBeHidden();
  const card = page
    .getByTestId('lead-column-NEW')
    .getByTestId('lead-card')
    .filter({ hasText: first });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Manual');

  // The panel of a manual lead has no conversation link.
  await card.getByTestId('lead-card-open').click();
  await expect(page.getByTestId('lead-panel')).toBeVisible();
  await expect(page.getByTestId('lead-panel-conversation')).toHaveCount(0);
  await page.getByTestId('lead-panel-close').click();

  // Column "+": the stage is preselected.
  const second = `Referral ${Date.now()}`;
  const column = page.getByTestId('lead-column-QUALIFIED');
  await column.getByTestId('lead-column-add').click();
  await expect(
    dialog.getByTestId('lead-add-stage').locator('option:checked'),
  ).toHaveText(/Qualified/u);
  await dialog.getByTestId('lead-add-name').fill(second);
  await dialog.getByTestId('lead-add-submit').click();
  await expect(dialog).toBeHidden();
  await expect(
    column.getByTestId('lead-card').filter({ hasText: second }),
  ).toBeVisible();

  // Closed columns have no "+".
  await expect(
    page.getByTestId('lead-column-WON').getByTestId('lead-column-add'),
  ).toHaveCount(0);
  await context.close();
});

test('a viewer cannot add a lead', async ({ browser }) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.viewer.email,
  );
  await page.goto('/leads?view=funnel');
  await expect(page.getByTestId('lead-column-NEW')).toBeVisible();
  await expect(page.getByTestId('lead-add')).toHaveCount(0);
  await expect(page.getByTestId('lead-column-add')).toHaveCount(0);
  await context.close();
});
