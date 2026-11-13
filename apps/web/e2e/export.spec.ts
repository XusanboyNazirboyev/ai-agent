import { expect, test, type Download } from '@playwright/test';
import { fixtures, newHandover, newSession } from './helpers';

async function readDownload(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

test.describe('CSV export (P1.9)', () => {
  test('owner downloads the people CSV of tenant A, formulas are neutralised', async ({
    browser,
  }) => {
    const f = fixtures();
    // A customer whose name is a spreadsheet formula (created by the fixture
    // script, which also creates the person row).
    const formula = `=HYPERLINK("http://example.invalid","x") ${Date.now()}`;
    newHandover(f.a.tenantId, formula);
    const owner = await newSession(browser, f.a.operators.owner.email);
    await owner.page.goto('/leads?view=list');
    const exportButton = owner.page.getByTestId('people-export');
    await expect(exportButton).toBeVisible();

    const [download] = await Promise.all([
      owner.page.waitForEvent('download'),
      exportButton.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^people-\d{8}\.csv$/);
    const content = await readDownload(download);
    expect(content.charCodeAt(0)).toBe(0xfeff);
    const lines = content.slice(1).split('\r\n');
    expect(lines[0]).toMatch(/^person_id,name,phone,channels,contacts,/);
    // The seeded tenant A customers are in the file ...
    expect(content).toContain(f.a.conversations[0].contactName);
    // ... and the formula is stored with a leading apostrophe, quoted (it has
    // commas and quotes), never as a cell that starts with "=".
    expect(content).toContain(
      `"'=HYPERLINK(""http://example.invalid"",""x"") `,
    );
    expect(content).not.toMatch(/(^|,)"?=/m);
    // Tenant B customers never appear.
    expect(content).not.toContain(fixtures().b.conversations[0].contactName);
    await owner.context.close();
  });

  test('operator does not see the export buttons', async ({ browser }) => {
    const f = fixtures();
    const op = await newSession(browser, f.a.operators.op1.email);
    await op.page.goto('/leads?view=list');
    await expect(
      op.page
        .getByTestId('person-item')
        .filter({ hasText: f.a.conversations[0].contactName }),
    ).toBeVisible();
    await expect(op.page.getByTestId('people-export')).toHaveCount(0);
    await op.page.goto('/leads?view=funnel');
    await expect(op.page.getByTestId('leads-export')).toHaveCount(0);
    await op.context.close();
  });
});
