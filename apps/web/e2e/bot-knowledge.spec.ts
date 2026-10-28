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

test.describe('FAQ file import', () => {
  test('a CSV file is imported, a second upload updates instead of duplicating, bad rows are reported', async ({
    browser,
  }) => {
    const f = fixtures();
    const stamp = Date.now();
    const q1 = `Import one ${stamp}?`;
    const q2 = `Import two ${stamp}?`;
    const csv = (answer: string): Buffer =>
      Buffer.from(
        `question,answer,language\n"${q1}","${answer}",en\n"${q2}","Second, with a comma.",ru\nx,too short question,\n`,
      );
    const admin = await newSession(browser, f.a.operators.admin.email);
    await admin.page.goto('/knowledge');
    await admin.page.getByTestId('faq-import').click();
    await admin.page.getByTestId('faq-import-file').setInputFiles({
      name: 'faq.csv',
      mimeType: 'text/csv',
      buffer: csv('First answer.'),
    });
    await expect(admin.page.getByTestId('faq-import-summary')).toContainText(
      '2 questions are ready to import',
    );
    await expect(admin.page.getByTestId('faq-import-summary')).toContainText(
      'Row 3',
    );
    await expect(admin.page.getByTestId('faq-import-start')).toBeDisabled();
    await admin.page.getByTestId('faq-import-consent').check();
    await admin.page.getByTestId('faq-import-start').click();
    await expect(admin.page.getByTestId('faq-import-result')).toContainText(
      '2 new, 0 updated',
    );

    await admin.page.getByTestId('faq-import-file').setInputFiles({
      name: 'faq.csv',
      mimeType: 'text/csv',
      buffer: csv('Changed answer.'),
    });
    await admin.page.getByTestId('faq-import-consent').check();
    await admin.page.getByTestId('faq-import-start').click();
    await expect(admin.page.getByTestId('faq-import-result')).toContainText(
      '0 new, 2 updated',
    );
    await admin.page.getByTestId('faq-import-close').click();
    const items = admin.page
      .getByTestId('faq-item')
      .filter({ hasText: String(stamp) });
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText(
      /Changed answer\.|Second, with a comma\./u,
    );
    // Clean up so the shared tenant keeps its size.
    for (let i = 0; i < 2; i += 1) {
      await items.first().getByTestId('faq-delete').click();
      await admin.page.getByTestId('confirm-accept').click();
      await expect(items).toHaveCount(1 - i);
    }
    await admin.context.close();
  });

  test('the import dialog fits a 320px screen', async ({ browser }) => {
    const f = fixtures();
    const admin = await newSession(browser, f.a.operators.admin.email, {
      viewport: { width: 320, height: 640 },
    });
    await admin.page.goto('/knowledge');
    await admin.page.getByTestId('faq-import').click();
    await admin.page.getByTestId('faq-import-file').setInputFiles({
      name: 'bad.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('foo,bar\n1,2\n'),
    });
    await expect(admin.page.getByTestId('faq-import-summary')).toBeVisible();
    expect(await findOverflow(admin.page)).toEqual([]);
    await admin.context.close();
  });
});

test.describe('Knowledge documents', () => {
  test('a text file is uploaded, replaced by title, listed with passages and withdrawn', async ({
    browser,
  }) => {
    const f = fixtures();
    const title = `Refund policy ${Date.now()}`;
    const long = `Refunds are possible within 14 days. ${'Details of the policy. '.repeat(70)}`;
    const admin = await newSession(browser, f.a.operators.admin.email);
    await admin.page.goto('/knowledge');
    await admin.page.getByTestId('knowledge-tab-documents').click();
    await admin.page.getByTestId('document-upload').click();
    await admin.page.getByTestId('document-file').setInputFiles({
      name: `${title}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(long),
    });
    await expect(admin.page.getByTestId('document-title')).toHaveValue(title);
    await expect(admin.page.getByTestId('document-save')).toBeDisabled();
    await admin.page.getByTestId('document-consent').check();
    await admin.page.getByTestId('document-save').click();
    const item = admin.page
      .getByTestId('document-item')
      .filter({ hasText: title });
    await expect(item).toContainText('Refunds are possible');
    await expect(item).toContainText(/\d+ passages/u);

    // Same title again replaces it: still one document, now one passage.
    await admin.page.getByTestId('document-upload').click();
    await admin.page.getByTestId('document-title').fill(title);
    await admin.page.getByTestId('document-text').fill('Short new text.');
    await admin.page.getByTestId('document-consent').check();
    await admin.page.getByTestId('document-save').click();
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('Short new text.');
    await expect(item).toContainText('1 passage');

    const operator = await newSession(browser, f.a.operators.op1.email);
    await operator.page.goto('/knowledge');
    await operator.page.getByTestId('knowledge-tab-documents').click();
    await expect(
      operator.page.getByTestId('document-item').filter({ hasText: title }),
    ).toBeVisible();
    await expect(operator.page.getByTestId('document-upload')).toHaveCount(0);
    await operator.context.close();

    await item.getByTestId('document-delete').click();
    await admin.page.getByTestId('confirm-accept').click();
    await expect(item).toHaveCount(0);
    await admin.context.close();
  });

  test('the upload form fits a 320px screen', async ({ browser }) => {
    const f = fixtures();
    const admin = await newSession(browser, f.a.operators.admin.email, {
      viewport: { width: 320, height: 640 },
    });
    await admin.page.goto('/knowledge');
    await admin.page.getByTestId('knowledge-tab-documents').click();
    await admin.page.getByTestId('document-upload').click();
    await admin.page.getByTestId('document-title').fill('Ж'.repeat(120));
    expect(await findOverflow(admin.page)).toEqual([]);
    await admin.context.close();
  });
});

test('the language switcher keeps icon, label and chevron apart', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  await page.getByLabel('Language', { exact: true }).selectOption('uz-Latn');
  const row = page.locator('header span:has(> select)').first();
  const boxes = await row.evaluate((element) => {
    const rect = (node: Element): { l: number; r: number } => {
      const box = node.getBoundingClientRect();
      return { l: box.left, r: box.right };
    };
    return Array.from(element.children).map(rect);
  });
  expect(boxes).toHaveLength(3);
  for (let i = 1; i < boxes.length; i += 1)
    expect(boxes[i].l).toBeGreaterThanOrEqual(boxes[i - 1].r - 0.5);
  await context.close();
});
