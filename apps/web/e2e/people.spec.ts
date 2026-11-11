import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';

test.describe('people page (P1.1 slice B)', () => {
  test('contacts page lists people and opens a person card', async ({
    browser,
  }) => {
    const f = fixtures();
    const ownerEmail = f.a.operators.owner.email;
    const { page, context } = await newSession(browser, ownerEmail);

    await page.goto('/contacts', { waitUntil: 'networkidle' });

    const firstRow = page.getByTestId('person-item').first();
    await expect(firstRow).toBeVisible();
    await firstRow.getByTestId('person-open-card').click();

    await expect(page).toHaveURL(/\/contacts\/.+/);
    await expect(page.getByTestId('person-header')).toBeVisible();
    await expect(page.getByTestId('person-contacts')).toBeVisible();
    await expect(page.getByTestId('person-conversations')).toBeVisible();
    await expect(page.getByTestId('person-leads')).toBeVisible();

    await context.close();
  });
});
