import { expect, test } from '@playwright/test';
import { fixtures, newHandover, newSession } from './helpers';

// AI | Operator switch (ADR 038): the bot answers until an operator writes;
// the first keystroke takes the conversation, "AI" gives it back.

test('typing in a conversation the bot holds switches it to the operator, and AI gives it back', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Mode ${Date.now()}`);
  const { page, context } = await newSession(browser, f.a.operators.op1.email);

  await page
    .getByTestId('conversation-item')
    .filter({ hasText: handover.contactName })
    .click();
  const state = page.getByTestId('state');
  await expect(state).toHaveAttribute('data-state', 'WAITING_OPERATOR');

  // AI: straight back to the bot, no dialog.
  await page.getByTestId('mode-ai').click();
  await expect(state).toHaveAttribute('data-state', 'BOT_ACTIVE');
  await expect(page.getByTestId('mode-ai')).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Writing while the bot holds the conversation takes it over.
  await page.getByTestId('reply-input').fill('Salom, operator yozmoqda');
  await expect(state).toHaveAttribute('data-state', 'OPERATOR_ACTIVE');
  await expect(page.getByTestId('take-over')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByTestId('send-reply').click();
  await expect(page.getByTestId('timeline')).toContainText(
    'Salom, operator yozmoqda',
  );
  await expect(page.getByTestId('reply-input')).toHaveValue('');

  await page.getByTestId('mode-ai').click();
  await expect(state).toHaveAttribute('data-state', 'BOT_ACTIVE');
  await context.close();
});

test('a viewer sees no AI | Operator switch and no composer', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `ModeView ${Date.now()}`);
  const { page, context } = await newSession(
    browser,
    f.a.operators.viewer.email,
  );
  await page
    .getByTestId('conversation-item')
    .filter({ hasText: handover.contactName })
    .click();
  await expect(page.getByTestId('state')).toBeVisible();
  await expect(page.getByTestId('mode-ai')).toHaveCount(0);
  await expect(page.getByTestId('reply-input')).toHaveCount(0);
  await context.close();
});
