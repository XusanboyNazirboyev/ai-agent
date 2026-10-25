import { expect, test } from '@playwright/test';
import { fixtures, newHandover, newSession, uncertainAction } from './helpers';

test('an operator resolves an action whose outcome is unknown; viewers and other tenants cannot', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Action ${Date.now()}`);
  const proposalId = uncertainAction(f.a.tenantId, handover.id);

  // Another tenant's operator cannot resolve it (not found, nothing changes).
  const other = await newSession(browser, f.b.operators.op1.email);
  const otherCsrf = (await other.context.cookies()).find(
    (c) => c.name === 'ac_csrf',
  )!.value;
  const foreign = await other.context.request.post(
    `/api/v1/inbox/actions/${proposalId}/resolve`,
    {
      headers: { 'x-csrf-token': otherCsrf },
      data: { outcome: 'SUCCEEDED', externalId: 'CRM-1' },
    },
  );
  expect(foreign.status()).toBe(404);
  await other.context.close();

  // A viewer sees the action but cannot resolve it.
  const viewer = await newSession(browser, f.a.operators.viewer.email);
  await viewer.page
    .getByTestId('conversation-item')
    .filter({ hasText: handover.contactName })
    .click();
  await expect(viewer.page.getByTestId('action-item')).toHaveAttribute(
    'data-status',
    'UNCERTAIN',
  );
  await expect(
    viewer.page.getByRole('button', { name: 'Mark as created' }),
  ).toHaveCount(0);
  const viewerCsrf = (await viewer.context.cookies()).find(
    (c) => c.name === 'ac_csrf',
  )!.value;
  const refused = await viewer.context.request.post(
    `/api/v1/inbox/actions/${proposalId}/resolve`,
    {
      headers: { 'x-csrf-token': viewerCsrf },
      data: { outcome: 'FAILED' },
    },
  );
  expect(refused.status()).toBe(403);
  await viewer.context.close();

  // The operator sees what was confirmed, needs the record id, then resolves it.
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  await page
    .getByTestId('conversation-item')
    .filter({ hasText: handover.contactName })
    .click();
  const item = page.getByTestId('action-item');
  await expect(item).toHaveAttribute('data-status', 'UNCERTAIN');
  await expect(item).toContainText('Outcome unknown');
  await expect(item).toContainText('IELTS');
  await page.getByRole('button', { name: 'Mark as created' }).click();
  await expect(page.getByTestId('actions-panel').getByRole('alert')).toHaveText(
    'Enter the record id from the connected system.',
  );
  await page.getByLabel('Record id in the connected system').fill('CRM-42');
  await page.getByRole('button', { name: 'Mark as created' }).click();
  await expect(item).toHaveAttribute('data-status', 'SUCCEEDED');
  await expect(item).toContainText('Record: CRM-42');
  // The confirmed values are no longer shown once resolved.
  await expect(item).not.toContainText('+998900000000');
  await context.close();
});

test('the actions panel is localized', async ({ browser }) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `ActionRu ${Date.now()}`);
  uncertainAction(f.a.tenantId, handover.id);
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  await page.getByLabel('Language', { exact: true }).selectOption('ru');
  await page
    .getByTestId('conversation-item')
    .filter({ hasText: handover.contactName })
    .click();
  await expect(page.getByTestId('action-item')).toContainText(
    'Результат неизвестен',
  );
  await expect(
    page.getByRole('button', { name: 'Отметить как созданное' }),
  ).toBeVisible();
  await context.close();
});
