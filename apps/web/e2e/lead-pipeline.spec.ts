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

  await page.goto('/leads?view=funnel');
  await expect(page.getByTestId('lead-column-NEW')).toBeVisible();

  await page.goto('/settings/pipeline');
  await expect(page.getByTestId('pipelines-list')).toBeVisible();
  const defaultCard = page.getByTestId('pipeline-card').first();
  await expect(defaultCard).toBeVisible();
  const rows = defaultCard.getByTestId('pipeline-stage-row');
  await expect(rows).toHaveCount(7);

  await defaultCard.getByTestId('stage-add-name').fill('Prospect');
  await defaultCard.getByTestId('stage-add').click();
  await expect(rows).toHaveCount(8);

  // New open stages sit before the closed WON/LOST columns.
  const customRow = rows.nth(5);
  const customName = customRow.getByLabel(
    /stage name|Название этапа|Bosqich nomi/i,
  );
  await expect(customName).toHaveValue('Prospect');
  await customName.fill('Qualified');
  await customRow.getByTestId('stage-save').click();
  await expect(customName).toHaveValue('Qualified');

  const operator = await newSession(browser, f.a.operators.op1.email);
  await operator.page.goto('/settings/pipeline');
  await expect(operator.page.getByTestId('pipeline-create')).toHaveCount(0);
  await expect(operator.page.getByTestId('pipeline-rename')).toHaveCount(0);
  await operator.context.close();
  await context.close();
});
