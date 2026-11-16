import { expect, test } from '@playwright/test';
import { fixtures, newHandover, newSession, postAsPage } from './helpers';

// Tags on a conversation (P1.8, ADR 071): set in the chat, shown in the list,
// used as a filter.

test('an operator tags a chat, sees the tag in the list and filters by it', async ({
  browser,
}) => {
  const f = fixtures();
  const tagName = `Delivery ${Date.now()}`;
  const handover = newHandover(f.a.tenantId, `Tagged ${Date.now()}`);
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
    {
      viewport: { width: 1440, height: 900 },
    },
  );
  let tagId = '';
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    const created = await postAsPage(page, '/api/v1/tags', { name: tagName });
    expect(created.status).toBe(201);
    tagId = String(created.body.id);

    const item = page
      .getByTestId('conversation-item')
      .filter({ hasText: handover.contactName });
    await item.click();
    // The tags are a collapsed section while the conversation has none.
    const section = page.getByTestId('conversation-tags-section');
    await expect(section).toContainText(/No tags|Нет тегов|Teglar yo/u);
    await section.locator('summary').click();
    const editor = page.getByTestId('conversation-tags');
    await editor.getByTestId('conversation-tag-add').click();
    await editor.getByTestId('conversation-tag-select').selectOption(tagId);
    await expect(
      editor.getByTestId('conversation-tag-chip').filter({ hasText: tagName }),
    ).toBeVisible();
    await expect(
      item.getByTestId('conversation-item-tag').filter({ hasText: tagName }),
    ).toBeVisible();

    await page.getByTestId('inbox-filters-toggle').click();
    await page.getByTestId('inbox-filter-tag').selectOption(tagId);
    await expect(page.getByTestId('conversation-item')).toHaveCount(1);
    await expect(page.getByTestId('conversation-item')).toContainText(
      handover.contactName,
    );
  } finally {
    if (tagId)
      await page.evaluate(async (id) => {
        const csrf = document.cookie
          .split('; ')
          .find((part) => part.startsWith('ac_csrf='))
          ?.slice('ac_csrf='.length);
        await fetch(`/api/v1/tags/${id}`, {
          method: 'DELETE',
          headers: csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {},
        });
      }, tagId);
    await context.close();
  }
});
