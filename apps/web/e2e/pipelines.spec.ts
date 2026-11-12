import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';

test.describe('Pipelines and opportunity (P1.3)', () => {
  test('owner can manage pipelines and stages in settings', async ({
    browser,
  }) => {
    const f = fixtures();
    const { page, context } = await newSession(
      browser,
      f.a.operators.owner.email,
    );
    await page.goto('/settings/pipeline');
    await expect(page.getByTestId('pipelines-list')).toBeVisible();
    // Create a second pipeline
    await page.getByTestId('pipeline-create').click();
    const createDialog = page.getByRole('dialog');
    await expect(createDialog).toBeVisible();
    await createDialog
      .getByLabel(/pipeline name|Название воронки|Voronka nomi/i)
      .fill('Enterprise');
    await createDialog
      .getByRole('button', { name: /save|Сохранить|Saqlash/i })
      .click();
    await expect(page.getByText('Enterprise')).toBeVisible();

    // Switch to it on the board (empty board)
    await page.goto('/leads?view=funnel');
    const switcher = page.getByRole('group', {
      name: /pipeline|Воронка|Vorona/i,
    });
    await expect(switcher).toBeVisible();
    await switcher.getByRole('button', { name: /Enterprise/ }).click();
    await expect(page).toHaveURL(/pipeline=/);

    // Rename a stage in settings
    await page.goto('/settings/pipeline');
    const enterpriseCard = page
      .getByTestId('pipeline-card')
      .filter({ hasText: 'Enterprise' });
    await expect(enterpriseCard).toBeVisible();
    const stageInput = enterpriseCard
      .getByLabel(/stage name|Название этапа|Bosqich nomi/i)
      .first();
    await stageInput.fill('Discovery');
    await enterpriseCard.getByTestId('stage-save').first().click();

    await context.close();
  });

  test('operator sees no management buttons', async ({ browser }) => {
    const f = fixtures();
    const { page, context } = await newSession(
      browser,
      f.a.operators.op1.email,
    );
    await page.goto('/settings/pipeline');
    await expect(page.getByTestId('pipelines-list')).toBeVisible();
    await expect(page.getByTestId('pipeline-create')).toHaveCount(0);
    await expect(page.getByTestId('pipeline-rename')).toHaveCount(0);
    await expect(page.getByTestId('pipeline-archive')).toHaveCount(0);
    await context.close();
  });
});
