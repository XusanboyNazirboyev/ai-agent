import { expect, test, type Page } from '@playwright/test';
import { fixtures, newSession } from './helpers';

/**
 * Opens the card of a seeded tenant A customer. All seeded customers share one
 * phone number, so each one has duplicate candidates; later specs add people
 * with other numbers, so the first list row is not a safe choice.
 */
async function openSeededPerson(page: Page, name: string): Promise<void> {
  await page.goto('/contacts', { waitUntil: 'networkidle' });
  await page.getByLabel('Search by name or phone').fill(name);
  const row = page.getByTestId('person-item').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await row.getByTestId('person-open-card').click();
  await expect(page.getByTestId('person-header')).toBeVisible();
}

test.describe('person merge (P1.1 slice C)', () => {
  test('admin sees duplicate banner and merge dialog on person card', async ({
    browser,
  }) => {
    const f = fixtures();
    const { page, context } = await newSession(
      browser,
      f.a.operators.admin.email,
    );
    await openSeededPerson(page, f.a.conversations[0].contactName);
    await expect(page.getByTestId('person-duplicates')).toBeVisible();
    await page.getByTestId('merge-candidate-into-person').first().click();
    await expect(page.getByTestId('merge-dialog')).toBeVisible();
    await expect(page.getByTestId('merge-confirm')).toBeDisabled();
    await page.getByTestId('merge-reason-input').fill('same customer');
    await expect(page.getByTestId('merge-confirm')).toBeEnabled();
    await page.getByTestId('merge-cancel').click();
    await context.close();
  });

  test('owner merges a duplicate into the open person and undoes it', async ({
    browser,
  }) => {
    const f = fixtures();
    const { page, context } = await newSession(
      browser,
      f.a.operators.owner.email,
    );
    await openSeededPerson(page, f.a.conversations[0].contactName);
    await expect(page.getByTestId('person-duplicates')).toBeVisible();
    const survivorUrl = page.url();
    await page.getByTestId('merge-candidate-into-person').first().click();
    const dialog = page.getByTestId('merge-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('merge-preview-counts')).toBeVisible();
    await dialog.getByTestId('merge-reason-input').fill('same customer');
    await dialog.getByTestId('merge-confirm').click();
    await expect(dialog).toBeHidden();

    // The survivor card now shows the merge and offers the undo.
    await expect(page).toHaveURL(survivorUrl);
    await expect(page.getByTestId('person-last-merge')).toBeVisible();
    await page.getByTestId('person-unmerge').click();
    await page.getByRole('dialog').getByTestId('confirm-accept').click();
    await expect(page.getByTestId('person-last-merge')).toBeHidden();
    await context.close();
  });

  test('operator and viewer see the duplicates but cannot merge', async ({
    browser,
  }) => {
    const f = fixtures();
    for (const key of ['op1', 'viewer'] as const) {
      const { page, context } = await newSession(
        browser,
        f.a.operators[key].email,
      );
      await openSeededPerson(page, f.a.conversations[0].contactName);
      await expect(page.getByTestId('person-duplicates')).toBeVisible();
      await expect(page.getByTestId('merge-candidate-into-person')).toHaveCount(
        0,
      );
      await context.close();
    }
  });
});
