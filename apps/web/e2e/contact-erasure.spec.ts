import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';

test('only the owner sees and can open the erase contact flow', async ({
  browser,
}) => {
  const f = fixtures();
  // `op1` is an OPERATOR: only the seeded OWNER fixture may erase a contact.
  const owner = await newSession(browser, f.a.operators.owner.email);
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

  // Neither an ADMIN nor a VIEWER sees the erase action (the API stays the
  // source of truth and answers 403).
  for (const key of ['admin', 'viewer'] as const) {
    const other = await newSession(browser, f.a.operators[key].email);
    await other.page.goto('/leads?view=list');
    await expect(other.page.getByTestId('contact-item').first()).toBeVisible();
    await expect(other.page.getByTestId('contact-erase')).toHaveCount(0);
    await other.context.close();
  }
});
