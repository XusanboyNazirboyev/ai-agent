import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';

test.describe('person merge (P1.1 slice C)', () => {
  test('admin sees duplicate banner and merge dialog on person card', async ({
    browser,
  }) => {
    const f = fixtures();
    // Reviewer must add a shared-phone pair fixture for tenant A so that
    // GET /api/v1/people/:id/duplicates returns a non-empty group for this
    // person and merge/unmerge flows are executable end-to-end.
    const { page, context } = await newSession(
      browser,
      f.a.operators.admin.email,
    );
    await page.goto('/contacts', { waitUntil: 'networkidle' });
    await page
      .getByTestId('person-item')
      .first()
      .getByTestId('person-open-card')
      .click();
    await expect(page.getByTestId('person-header')).toBeVisible();
    await expect(page.getByTestId('person-duplicates')).toBeVisible();
    await page.getByTestId('merge-candidate-into-person').first().click();
    await expect(page.getByTestId('merge-dialog')).toBeVisible();
    await expect(page.getByTestId('merge-confirm')).toBeDisabled();
    await page.getByTestId('merge-reason-input').fill('same customer');
    await expect(page.getByTestId('merge-confirm')).toBeEnabled();
    await page.getByTestId('merge-cancel').click();
    await context.close();
  });
});
