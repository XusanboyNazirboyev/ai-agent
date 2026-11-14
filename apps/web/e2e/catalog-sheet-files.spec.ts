import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixtures, newSession } from './helpers';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const SAMPLE = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../docs/samples/tourism-price-list.sample.csv',
  ),
);

/** Price list upload edge cases (ADR 064). Tenant B: its admin uploads, so
 * tenant A's connector roles stay as the other specs expect them. */

/** Reads a fixture from apps/web/e2e/fixtures/. */
function fixture(name: string): Buffer {
  return readFileSync(resolve(FIXTURES, name));
}
async function upload(
  page: Page,
  buffer: Buffer,
  fileName: string,
): Promise<void> {
  await page.getByTestId('sheet-file').setInputFiles({
    name: fileName,
    mimeType: 'text/csv',
    buffer,
  });
}

function counts(page: Page): Locator {
  return page.getByTestId('sheet-counts');
}

test('semicolon file with UTF-8 BOM and CRLF: columns are guessed', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    await page.goto('/settings/catalog');
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const text =
      'Destination;Hotel;Price per person;Currency\r\n' +
      'Dubai;Rixos Premium Palm;820;USD\r\n' +
      'Sharm el-Sheikh;Nova Beach Resort;710;USD\r\n';
    await upload(
      page,
      Buffer.concat([bom, Buffer.from(text, 'utf8')]),
      'tours.csv',
    );
    // Price per person is column index 2 (0-based).
    await expect(page.getByTestId('sheet-map-price')).toHaveValue('2');
    await expect(counts(page)).toContainText('2');
    await expect(counts(page)).toContainText('0');
  } finally {
    await context.close();
  }
});

test('Russian headers: mapping selects show the right columns', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    await page.goto('/settings/catalog');
    await upload(page, fixture('russian-headers.csv'), 'russian.csv');
    // Цена за человека is column index 5 (0-based).
    const priceSelect = page.getByTestId('sheet-map-price');
    await expect(priceSelect).toHaveValue('5');
    await expect(priceSelect.locator('option:checked')).toHaveText(
      'Цена за человека',
    );
    await expect(counts(page)).toContainText('3');
    await expect(counts(page)).toContainText('0');
  } finally {
    await context.close();
  }
});

test('Uzbek headers with apostrophes: mapping selects show the right columns', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    await page.goto('/settings/catalog');
    await upload(page, fixture('uzbek-headers.csv'), 'uzbek.csv');
    // Narxi is column index 5 (0-based).
    const priceSelect = page.getByTestId('sheet-map-price');
    await expect(priceSelect).toHaveValue('5');
    await expect(priceSelect.locator('option:checked')).toHaveText('Narxi');
    // The fixture has two data rows.
    await expect(counts(page)).toContainText('2 rows will be saved, 0 will');
  } finally {
    await context.close();
  }
});

test('price formats are normalised in the sample rows', async ({ browser }) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    await page.goto('/settings/catalog');
    await upload(page, fixture('price-formats.csv'), 'prices.csv');
    await page.getByTestId('sheet-map-price').selectOption('2');
    await page.getByTestId('sheet-map-currency').selectOption('3');
    const rows = page.getByTestId('sheet-sample-row');
    await expect(rows).toHaveCount(4);
    await expect(counts(page)).toContainText('4');
    await expect(counts(page)).toContainText('0');
    // Normalised prices: 1 240 -> 1240, 1.250,50 -> 1250.50, 710,5 -> 710.5, $ 820 -> 820.
    await expect(rows.nth(0)).toContainText('1240');
    await expect(rows.nth(1)).toContainText('1250.50');
    await expect(rows.nth(2)).toContainText(/710\.5(?!\d)/u);
    await expect(rows.nth(3)).toContainText('820');
  } finally {
    await context.close();
  }
});

test('all rows bad: 0 accepted, save disabled, every skipped line listed', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    await page.goto('/settings/catalog');
    await upload(page, fixture('all-bad.csv'), 'bad.csv');
    await page.getByTestId('sheet-map-price').selectOption('2');
    await expect(counts(page)).toContainText('0');
    await expect(counts(page)).toContainText('3');
    await expect(page.getByTestId('sheet-save')).toBeDisabled();
    const skipped = page.getByTestId('sheet-skipped-row');
    await expect(skipped).toHaveCount(3);
    // Every skipped line lists its own line number (2, 3, 4).
    await expect(skipped.nth(0)).toContainText('2');
    await expect(skipped.nth(1)).toContainText('3');
    await expect(skipped.nth(2)).toContainText('4');
  } finally {
    await context.close();
  }
});

test('header-only and empty files: error visible, no save button', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    await page.goto('/settings/catalog');

    await upload(page, fixture('header-only.csv'), 'header-only.csv');
    await expect(page.getByTestId('sheet-error')).toBeVisible();
    await expect(page.getByTestId('sheet-save')).toHaveCount(0);

    await upload(page, Buffer.from(''), 'empty.csv');
    await expect(page.getByTestId('sheet-error')).toBeVisible();
    await expect(page.getByTestId('sheet-save')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('105 bad rows: at most 100 skipped shown, more-rows note visible', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    await page.goto('/settings/catalog');
    const lines = ['Destination,Hotel,Price,Currency'];
    for (let i = 0; i < 105; i++) {
      lines.push(`Dubai,Hotel ${i},bad,USD`);
    }
    await upload(page, Buffer.from(lines.join('\n')), 'many-bad.csv');
    await page.getByTestId('sheet-map-price').selectOption('2');
    const skipped = page.getByTestId('sheet-skipped-row');
    await expect(skipped).toHaveCount(100);
    await expect(
      page.getByText('More rows were skipped than shown here.'),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test('file larger than 5 MB: refused in browser, no preview request', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    await page.goto('/settings/catalog');
    let previewRequests = 0;
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/catalog/sheet/preview')) {
        previewRequests += 1;
      }
    });
    const big = Buffer.alloc(5.2 * 1024 * 1024, 'x');
    await upload(page, big, 'big.csv');
    await expect(
      page.getByText('The file is too large (up to 5 MB).'),
    ).toBeVisible();
    await expect(page.getByTestId('sheet-save')).toHaveCount(0);
    expect(previewRequests).toBe(0);
  } finally {
    await context.close();
  }
});

test('replacing: 1-row file then sample, status shows 12 accepted, old row gone', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    await page.goto('/settings/catalog');

    // Upload and save a 1-row file.
    const oneRow =
      'Destination,Hotel,Price,Currency\nDubai,One Row Hotel,100,USD\n';
    await upload(page, Buffer.from(oneRow), 'one-row.csv');
    await page.getByTestId('sheet-map-price').selectOption('2');
    await expect(counts(page)).toContainText('1');
    await expect(counts(page)).toContainText('0');
    await page.getByTestId('sheet-save').click();
    await expect(page.getByTestId('sheet-status')).toContainText(
      /: 1 rows saved/u,
    );

    // Re-upload the sample and save; the catalog is replaced.
    await upload(page, SAMPLE, 'tours.csv');
    await expect(page.getByTestId('sheet-map-price')).toHaveValue('9');
    await expect(counts(page)).toContainText('12');
    await expect(counts(page)).toContainText('3');
    await page.getByTestId('sheet-save').click();
    await expect(page.getByTestId('sheet-status')).toContainText(
      /: 12 rows saved/u,
    );
    // The saved list is the new one: the old row is not in the catalog.
    const found = await page.evaluate(async () => {
      const response = await fetch('/api/v1/catalog/sheet');
      return (await response.json()) as { acceptedCount: number };
    });
    expect(found.acceptedCount).toBe(12);
  } finally {
    await context.close();
  }
});

test('wrong role by API: operator gets 403, admin JSON body gets 400', async ({
  browser,
}) => {
  const f = fixtures();

  // Operator of tenant B: POST /api/v1/catalog/sheet with text/csv -> 403.
  const { page, context } = await newSession(browser, f.b.operators.op1.email);
  try {
    await page.goto('/settings/catalog');
    const csrf = await page.evaluate(() => {
      const match = document.cookie.match(/(?:^|; )ac_csrf=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    });
    const status = await page.evaluate(
      async ({ csrf, body, contentType }) => {
        const res = await fetch('/api/v1/catalog/sheet', {
          method: 'POST',
          headers: {
            'x-csrf-token': csrf,
            'content-type': contentType,
          },
          body,
          credentials: 'include',
        });
        return res.status;
      },
      {
        csrf,
        body: 'Destination,Hotel,Price\nDubai,X,100,USD\n',
        contentType: 'text/csv',
      },
    );
    expect(status).toBe(403);
  } finally {
    await context.close();
  }

  // Admin with application/json body -> 400 INVALID_BODY.
  const { page: page2, context: context2 } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    await page2.goto('/settings/catalog');
    const csrf2 = await page2.evaluate(() => {
      const match = document.cookie.match(/(?:^|; )ac_csrf=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    });
    const result = await page2.evaluate(
      async ({ csrf, body }) => {
        const res = await fetch('/api/v1/catalog/sheet', {
          method: 'POST',
          headers: {
            'x-csrf-token': csrf,
            'content-type': 'application/json',
          },
          body,
          credentials: 'include',
        });
        const json = await res.json().catch(() => ({}));
        return { status: res.status, code: json.code };
      },
      { csrf: csrf2, body: JSON.stringify({ foo: 'bar' }) },
    );
    expect(result.status).toBe(400);
    expect(result.code).toBe('INVALID_BODY');
  } finally {
    await context2.close();
  }
});

test('formulas in cells: shown as plain text, no popup', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    let popups = 0;
    page.on('popup', () => {
      popups += 1;
    });
    await page.goto('/settings/catalog');
    await upload(page, fixture('formulas.csv'), 'formulas.csv');
    await page.getByTestId('sheet-map-price').selectOption('2');
    const rows = page.getByTestId('sheet-sample-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText(
      '=HYPERLINK("http://example.test","x")',
    );
    await expect(rows.nth(1)).toContainText('+1+1');
    await expect(rows.nth(2)).toContainText('@SUM(A1)');
    expect(popups).toBe(0);
  } finally {
    await context.close();
  }
});
