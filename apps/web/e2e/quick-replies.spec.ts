import { expect, test } from '@playwright/test';
import { findOverflow, fixtures, newHandover, newSession } from './helpers';

// The workspace's quick replies (P1.8, ADR 070): written in Settings, used in
// the composer.

test('an admin writes a quick reply and an operator inserts it into a reply', async ({
  browser,
}) => {
  const f = fixtures();
  const name = `Prices ${Date.now()}`;
  const text = `Our prices start at the catalog price. ${Date.now()}`;
  const admin = await newSession(browser, f.a.operators.admin.email, {
    viewport: { width: 390, height: 844 },
  });
  try {
    await admin.page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    await admin.page.goto('/settings/replies');
    await admin.page.getByTestId('reply-title').fill(name);
    await admin.page.getByTestId('reply-text').fill(text);
    await admin.page.getByTestId('reply-save').click();
    await expect(
      admin.page.getByTestId('reply-item').filter({ hasText: name }),
    ).toBeVisible();
    expect(await findOverflow(admin.page)).toEqual([]);

    const handover = newHandover(f.a.tenantId, `Quick ${Date.now()}`);
    const op = await newSession(browser, f.a.operators.op1.email);
    try {
      await op.page
        .getByTestId('conversation-item')
        .filter({ hasText: handover.contactName })
        .click();
      await op.page.getByTestId('take-over').click();
      await op.page
        .getByTestId('quick-reply-select')
        .selectOption({ label: name });
      await expect(op.page.getByTestId('reply-input')).toHaveValue(text);
    } finally {
      await op.context.close();
    }
  } finally {
    // The fixture workspace is shared: leave it with the built-in replies.
    const row = admin.page.getByTestId('reply-item').filter({ hasText: name });
    if (await row.count()) {
      await admin.page.goto('/settings/replies');
      await row.getByTestId('reply-delete').click();
      await admin.page
        .getByRole('button', { name: 'Delete', exact: true })
        .click();
      await expect(row).toHaveCount(0);
    }
    await admin.context.close();
  }
});
