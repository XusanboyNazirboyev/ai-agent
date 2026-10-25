import { expect, test } from '@playwright/test';
import { findOverflow, fixtures, newSession } from './helpers';

test.describe('AI bot page', () => {
  test('an admin switches the assistant on and off; an operator can only look', async ({
    browser,
  }) => {
    const f = fixtures();
    const admin = await newSession(browser, f.a.operators.admin.email);
    await admin.page.goto('/bot');
    const current = admin.page.getByTestId('bot-current');
    await expect(current).toHaveAttribute('data-mode', 'OFF');

    await admin.page.getByTestId('bot-mode-SHADOW').click({ force: true });
    await expect(current).toHaveAttribute('data-mode', 'SHADOW');

    // "On" asks first; cancelling changes nothing.
    await admin.page.getByTestId('bot-mode-LIVE').click({ force: true });
    await expect(admin.page.getByRole('dialog')).toBeVisible();
    await admin.page.getByTestId('confirm-cancel').click();
    await expect(current).toHaveAttribute('data-mode', 'SHADOW');
    await admin.page.getByTestId('bot-mode-LIVE').click({ force: true });
    await admin.page.getByTestId('confirm-accept').click();
    await expect(current).toHaveAttribute('data-mode', 'LIVE');
    await admin.page.reload();
    await expect(current).toHaveAttribute('data-mode', 'LIVE');

    // An operator sees the state but every choice is disabled.
    const operator = await newSession(browser, f.a.operators.op1.email);
    await operator.page.goto('/bot');
    await expect(operator.page.getByTestId('bot-current')).toHaveAttribute(
      'data-mode',
      'LIVE',
    );
    await expect(operator.page.getByTestId('bot-mode-OFF')).toBeDisabled();
    await expect(operator.page.getByTestId('bot-mode-SHADOW')).toBeDisabled();
    await operator.context.close();

    await admin.page.getByTestId('bot-mode-OFF').click({ force: true });
    await expect(current).toHaveAttribute('data-mode', 'OFF');
    await admin.context.close();
  });
});

test.describe('Knowledge page', () => {
  test('an admin adds, edits, searches and deletes a question; an operator can read only', async ({
    browser,
  }) => {
    const f = fixtures();
    const stamp = Date.now();
    const question = `How long is the course ${stamp}?`;
    const admin = await newSession(browser, f.a.operators.admin.email);
    await admin.page.goto('/knowledge');
    await admin.page.getByTestId('faq-add').click();
    await admin.page.getByTestId('faq-question').fill(question);
    await admin.page.getByTestId('faq-answer').fill('Three months.');
    // Saving is blocked until the provider notice is acknowledged.
    await expect(admin.page.getByTestId('faq-save')).toBeDisabled();
    await admin.page.getByTestId('faq-consent').check();
    await admin.page.getByTestId('faq-save').click();
    const item = admin.page
      .getByTestId('faq-item')
      .filter({ hasText: question });
    await expect(item).toContainText('Three months.');

    await item.getByTestId('faq-edit').click();
    await expect(admin.page.getByTestId('faq-answer')).toHaveValue(
      'Three months.',
    );
    await admin.page.getByTestId('faq-answer').fill('Four months.');
    await admin.page.getByTestId('faq-consent').check();
    await admin.page.getByTestId('faq-save').click();
    await expect(item).toContainText('Four months.');

    await admin.page
      .getByLabel('Search questions')
      .fill('no-such-text-anywhere');
    await expect(item).toHaveCount(0);
    await admin.page.getByLabel('Search questions').fill(String(stamp));
    await expect(item).toHaveCount(1);

    const operator = await newSession(browser, f.a.operators.op1.email);
    await operator.page.goto('/knowledge');
    await expect(
      operator.page.getByTestId('faq-item').filter({ hasText: question }),
    ).toBeVisible();
    await expect(operator.page.getByTestId('faq-add')).toHaveCount(0);
    await expect(operator.page.getByTestId('faq-delete')).toHaveCount(0);
    await operator.context.close();

    // Another tenant never sees it.
    const other = await newSession(browser, f.b.operators.op1.email);
    await other.page.goto('/knowledge');
    await expect(other.page.getByTestId('faq-count')).toBeVisible();
    await expect(
      other.page.getByTestId('faq-item').filter({ hasText: question }),
    ).toHaveCount(0);
    await other.context.close();

    await item.getByTestId('faq-delete').click();
    await admin.page.getByTestId('confirm-accept').click();
    await expect(item).toHaveCount(0);
    await admin.context.close();
  });

  test('the form fits a 320px screen', async ({ browser }) => {
    const f = fixtures();
    const admin = await newSession(browser, f.a.operators.admin.email, {
      viewport: { width: 320, height: 640 },
    });
    await admin.page.goto('/knowledge');
    await admin.page.getByTestId('faq-add').click();
    await expect(admin.page.getByTestId('faq-dialog')).toBeVisible();
    await admin.page.getByTestId('faq-question').fill('Ж'.repeat(150));
    expect(await findOverflow(admin.page)).toEqual([]);
    await admin.context.close();
  });
});
