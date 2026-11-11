import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';

test('only the owner sees and can open the erase contact flow', async ({
  browser,
}) => {
  const f = fixtures();
  const owner = await newSession(browser, f.a.operators.op1.email);
  await owner.page.goto('/leads?view=list');
  const item = owner.page.getByTestId('contact-item').first();
  await expect(item).toBeVisible();
  await item.getByTestId('contact-erase').click();
  const dialog = owner.page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('heading', { name: 'Erase this contact?' }),
  ).toBeVisible();
  await dialog.getByTestId('confirm-cancel').click();
  await expect(dialog).toBeHidden();
  await owner.context.close();

  // A non-owner must not see the erase action (API remains the source of truth).
  const viewer = await newSession(browser, f.a.operators.viewer.email);
  await viewer.page.goto('/leads?view=list');
  await expect(viewer.page.getByTestId('contact-item').first()).toBeVisible();
  await expect(viewer.page.getByTestId('contact-erase')).toHaveCount(0);
  await viewer.context.close();
});
