import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';

test('leads offer a contact list and configurable funnel stages', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
  );

  await page.goto('/leads?view=list');
  await expect(page.getByTestId('person-item').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Funnel' }).click();
  await expect(page.getByTestId('lead-column-NEW')).toBeVisible();
  await expect(
    page.getByTestId('lead-column-NEW').getByTestId('lead-card').first(),
  ).toBeVisible();

  await page.goto('/settings/pipeline');
  const stages = page.getByLabel('Stage name');
  await expect(stages).toHaveCount(7);
  await page.getByLabel('New stage').fill('Prospect');
  await page.getByRole('button', { name: 'Add stage' }).click();
  await expect(stages).toHaveCount(8);

  // New open stages sit before the closed WON/LOST columns.
  const customName = stages.nth(5);
  await expect(customName).toHaveValue('Prospect');
  await customName.fill('Qualified');
  await customName
    .locator('xpath=ancestor::li')
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(customName).toHaveValue('Qualified');

  const operator = await newSession(browser, f.a.operators.op1.email);
  await operator.page.goto('/settings/pipeline');
  await expect(operator.page.getByLabel('Stage name').first()).toBeDisabled();
  await expect(
    operator.page.getByRole('button', { name: 'Add stage' }),
  ).toHaveCount(0);
  await operator.context.close();
  await context.close();
});
