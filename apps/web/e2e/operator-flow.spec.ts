import { expect, test } from '@playwright/test';
import { fixtures, newHandover, newSession } from './helpers';

test('operator completes see → take over → reply → return in the browser', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Flow ${Date.now()}`);
  const { page, context } = await newSession(browser, f.a.operators.op1.email);

  const item = page
    .getByTestId('conversation-item')
    .filter({ hasText: handover.contactName });
  await expect(item).toBeVisible();
  await item.click();
  const state = page.getByTestId('state');
  await expect(state).toHaveAttribute('data-state', 'WAITING_OPERATOR');
  await expect(page.getByTestId('timeline')).toContainText('New customer');

  await page.getByTestId('take-over').click();
  await expect(state).toHaveAttribute('data-state', 'OPERATOR_ACTIVE');

  await page.getByTestId('reply-input').fill('Hello, how can I help?');
  await page.getByTestId('send-reply').click();
  await expect(page.getByTestId('timeline')).toContainText(
    'Hello, how can I help?',
  );
  await expect(page.getByTestId('reply-input')).toHaveValue('');

  await page
    .getByRole('textbox', { name: /Internal note/u })
    .fill('Customer prefers evenings');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByTestId('notes')).toContainText(
    'Customer prefers evenings',
  );

  await page.getByRole('tab', { name: 'Mine' }).click();
  await expect(
    page
      .getByTestId('conversation-item')
      .filter({ hasText: handover.contactName }),
  ).toHaveCount(1);

  await page
    .getByTestId('conversation-item')
    .filter({ hasText: handover.contactName })
    .click();
  await page.getByTestId('return-to-bot').click();
  await expect(state).toHaveAttribute('data-state', 'BOT_ACTIVE');
  await context.close();
});

test('closing a conversation moves it to the closed view', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Close ${Date.now()}`);
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  await page
    .getByTestId('conversation-item')
    .filter({ hasText: handover.contactName })
    .click();
  await page.getByTestId('take-over').click();
  await page.getByTestId('close').click();
  await expect(page.getByTestId('state')).toHaveAttribute(
    'data-state',
    'CLOSED',
  );
  await page.getByRole('tab', { name: 'Closed' }).click();
  await expect(
    page
      .getByTestId('conversation-item')
      .filter({ hasText: handover.contactName }),
  ).toBeVisible();
  await context.close();
});

test('changes the lead status and searches by contact name and message text', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  const first = f.a.conversations[0];
  await page.getByRole('tab', { name: 'All' }).click();
  await page
    .getByTestId('conversation-item')
    .filter({ hasText: first.contactName })
    .click();
  await expect(page.getByTestId('conversation-view')).toContainText('Hot');
  await page.getByLabel('Lead status').selectOption('IN_PROGRESS');
  await expect(page.getByLabel('Lead status')).toHaveValue('IN_PROGRESS');
  await page.reload();
  await expect(page.getByLabel('Lead status')).toHaveValue('IN_PROGRESS');

  await page
    .getByPlaceholder('Search name, phone or message')
    .fill('need a person');
  await expect(page.getByTestId('conversation-item')).toHaveCount(1);
  await expect(page.getByTestId('conversation-item')).toContainText('Bob');
  await page
    .getByPlaceholder('Search name, phone or message')
    .fill(first.contactName);
  await expect(page.getByTestId('conversation-item')).toHaveCount(1);
  await context.close();
});

test('shows the SLA banner for an overdue handover', async ({ browser }) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  await expect(page.getByTestId('sla-banner')).toContainText(
    'past the response deadline',
  );
  await context.close();
});

test('a quick reply is inserted into the composer', async ({ browser }) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Canned ${Date.now()}`);
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  await page
    .getByTestId('conversation-item')
    .filter({ hasText: handover.contactName })
    .click();
  await page.getByTestId('take-over').click();
  await page.getByLabel('Quick replies').selectOption('thanks');
  await expect(page.getByTestId('reply-input')).toHaveValue(
    'Thank you for your patience.',
  );
  await context.close();
});
