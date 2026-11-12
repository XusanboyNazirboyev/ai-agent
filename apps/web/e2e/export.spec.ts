import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';

test.describe('CSV export (P1.9)', () => {
  test('owner can export people CSV with BOM/header and neutralised values; operator cannot export', async ({
    browser,
  }) => {
    const f = fixtures();
    const owner = await newSession(browser, f.a.operators.owner.email);
    await owner.page.goto('/contacts', { waitUntil: 'networkidle' });
    await expect(owner.page.getByTestId('person-item').first()).toBeVisible();
    const exportBtn = owner.page.getByTestId('people-export');
    await expect(exportBtn).toBeVisible();

    const [download] = await Promise.all([
      owner.page.waitForEvent('download'),
      exportBtn.click(),
    ]);
    const name = download.suggestedFilename();
    expect(name).toMatch(/^people-\d{8}\.csv$/);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    if (stream) {
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    }
    const content = Buffer.concat(chunks).toString('utf8');
    expect(content.charCodeAt(0)).toBe(0xfeff); // BOM
    const firstLine = content.replace(/^\ufeff/, '').split(/\r?\n/)[0] ?? '';
    expect(firstLine).toContain('person_id');
    expect(firstLine).toContain('name');
    expect(firstLine).toContain('tags');
    // Formula-injection defence: dangerous leading chars are prefixed with '
    // (if present in data they must be neutralised)
    expect(content).not.toMatch(/(^|[\r\n],?)=[^"']/);
    await owner.context.close();

    // Operator cannot see export controls
    const op = await newSession(browser, f.a.operators.op1.email);
    await op.page.goto('/contacts', { waitUntil: 'networkidle' });
    await expect(op.page.getByTestId('people-export')).toHaveCount(0);
    await op.page.goto('/leads?view=funnel', { waitUntil: 'networkidle' });
    await expect(op.page.getByTestId('leads-export')).toHaveCount(0);
    await op.context.close();
  });
});
