import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';

test.describe('tags and custom fields (P1.5, web)', () => {
  test('owner manages tags in settings, attaches to person, filters list; operator cannot manage definitions', async ({
    browser,
  }) => {
    const f = fixtures();
    const { page, context } = await newSession(
      browser,
      f.a.operators.owner.email,
    );

    await page.goto('/settings/fields', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('tag-name-input')).toBeVisible();
    await page.getByTestId('tag-name-input').fill('E2E VIP');
    await page.getByTestId('tag-create').click();
    await expect(
      page.getByTestId('tag-row').filter({ hasText: 'E2E VIP' }),
    ).toBeVisible();

    await page.getByTestId('def-label-input').fill('Company');
    await page.getByTestId('def-key-input').fill('company');
    await page.getByTestId('def-create').click();
    await expect(
      page.getByTestId('def-row').filter({ hasText: 'Company' }),
    ).toBeVisible();

    // attach to a seeded person card
    await page.goto('/contacts', { waitUntil: 'networkidle' });
    const row = page.getByTestId('person-item').first();
    await row.getByTestId('person-open-card').click();
    await expect(page.getByTestId('person-header')).toBeVisible();
    await page.getByTestId('person-tag-add').click();
    await page
      .getByTestId('person-tag-select')
      .selectOption({ label: 'E2E VIP' });
    await expect(
      page.getByTestId('person-tag-chip').filter({ hasText: 'E2E VIP' }),
    ).toBeVisible();

    await page.goto('/contacts', { waitUntil: 'networkidle' });
    await page
      .getByTestId('people-tag-filter')
      .selectOption({ label: 'E2E VIP' });
    await expect(
      page.getByTestId('person-row-tag').filter({ hasText: 'E2E VIP' }).first(),
    ).toBeVisible();

    await context.close();

    // operator cannot manage definitions (read-only in settings)
    const op = await newSession(browser, f.a.operators.op1.email);
    await op.page.goto('/settings/fields', { waitUntil: 'networkidle' });
    await expect(op.page.getByTestId('tag-name-input')).toHaveCount(0);
    await expect(op.page.getByTestId('def-label-input')).toHaveCount(0);
    await op.context.close();
  });
});
