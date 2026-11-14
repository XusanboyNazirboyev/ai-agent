import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  makeXlsx,
  type TestCell,
  type TestRow,
} from '../src/lib/xlsx-test-file';
import { fixtures, newSession } from './helpers';

// Excel upload (ADR 064 S3): the browser turns the sheet into CSV, the server
// reads CSV only. Tenant B's admin uploads; tenant A is never touched.

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function upload(
  page: Page,
  name: string,
  buffer: Uint8Array,
): Promise<void> {
  await page.getByTestId('sheet-file').setInputFiles({
    name,
    mimeType: XLSX_MIME,
    buffer: Buffer.from(buffer),
  });
}

const counts = (page: Page): Locator => page.getByTestId('sheet-counts');

/** A price list like an agency keeps it in Excel: text, numbers and real date cells. */
function agencyBook(): Uint8Array {
  const shared = [
    'Destination',
    'Hotel',
    'Nights',
    'Price per person',
    'Currency',
    'Departure date',
    'Dubai',
    'Rixos Premium Palm',
    'USD',
    'Sharm el-Sheikh',
    'Nova Beach Resort',
  ];
  const text = (ref: string, index: number): TestCell => ({
    ref,
    t: 's',
    v: String(index),
  });
  const rows: TestRow[] = [
    {
      r: 1,
      cells: [
        text('A1', 0),
        text('B1', 1),
        text('C1', 2),
        text('D1', 3),
        text('E1', 4),
        text('F1', 5),
      ],
    },
    {
      r: 2,
      cells: [
        text('A2', 6),
        text('B2', 7),
        { ref: 'C2', v: '5' },
        { ref: 'D2', v: '820' },
        text('E2', 8),
        { ref: 'F2', s: 1, v: '46095' },
      ],
    },
    {
      r: 3,
      cells: [
        text('A3', 9),
        text('B3', 10),
        { ref: 'C3', v: '7' },
        { ref: 'D3', v: '710.5' },
        text('E3', 8),
        { ref: 'F3', s: 1, v: '46117' },
      ],
    },
  ];
  return makeXlsx({
    shared,
    xfFormats: [0, 14],
    sheets: [{ name: 'Prices', rows }],
  });
}

test('an Excel price list is read in the browser: columns guessed, date cells become dates', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    const requests: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url().includes('/api/v1/catalog/sheet')
      )
        requests.push(
          `${request.method()} ${request.headers()['content-type']}`,
        );
    });
    await page.goto('/settings/catalog');
    await upload(page, 'tours.xlsx', agencyBook());
    await expect(page.getByTestId('sheet-map-price')).toHaveValue('3');
    await expect(page.getByTestId('sheet-map-departureDate')).toHaveValue('5');
    await expect(counts(page)).toContainText('2 rows will be saved, 0 will');
    const rows = page.getByTestId('sheet-sample-row');
    await expect(rows).toHaveCount(2);
    // 46095 and 46117 are date serials: they arrive as real dates.
    await expect(rows.nth(0)).toContainText('2026-03-14');
    await expect(rows.nth(1)).toContainText('2026-04-05');
    await expect(rows.nth(1)).toContainText('710.5');
    // The server only ever received CSV text.
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.endsWith('text/csv'))).toBe(true);
    // One sheet: no sheet choice.
    await expect(page.getByTestId('sheet-select')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('a workbook with several sheets offers the ones with data and switches between them', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    const shared = [
      'Hotel',
      'Price',
      'Currency',
      'First Hotel',
      'USD',
      'Second Hotel',
      'Third Hotel',
    ];
    const cell = (ref: string, index: number): TestCell => ({
      ref,
      t: 's',
      v: String(index),
    });
    const rows = (data: Array<[string, number, string]>): TestRow[] => [
      { r: 1, cells: [cell('A1', 0), cell('B1', 1), cell('C1', 2)] },
      ...data.map(([hotel, price, currency], i) => ({
        r: i + 2,
        cells: [
          cell(`A${i + 2}`, shared.indexOf(hotel)),
          { ref: `B${i + 2}`, v: String(price) },
          cell(`C${i + 2}`, shared.indexOf(currency)),
        ],
      })),
    ];
    const workbook = makeXlsx({
      shared,
      sheets: [
        { name: 'Summer', rows: rows([['First Hotel', 100, 'USD']]) },
        {
          name: 'Winter',
          rows: rows([
            ['Second Hotel', 200, 'USD'],
            ['Third Hotel', 300, 'USD'],
          ]),
        },
        {
          name: 'Internal',
          state: 'hidden',
          rows: rows([['First Hotel', 5, 'USD']]),
        },
      ],
    });
    await page.goto('/settings/catalog');
    await upload(page, 'seasons.xlsx', workbook);
    await expect(counts(page)).toContainText('1 rows will be saved');
    const select = page.getByTestId('sheet-select');
    await expect(select).toBeVisible();
    await expect(select.locator('option')).toHaveText(['Summer', 'Winter']);
    await select.selectOption({ label: 'Winter' });
    await expect(counts(page)).toContainText('2 rows will be saved');
    await expect(page.getByTestId('sheet-sample-row').first()).toContainText(
      'Second Hotel',
    );
  } finally {
    await context.close();
  }
});

test('an old .xls file and a broken .xlsx are refused in the browser with a clear message', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    const previews: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/catalog/sheet/preview'))
        previews.push(request.url());
    });
    await page.goto('/settings/catalog');
    await page.getByTestId('sheet-file').setInputFiles({
      name: 'old.xls',
      mimeType: 'application/vnd.ms-excel',
      buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]),
    });
    await expect(
      page.getByText('Old .xls files are not supported'),
    ).toBeVisible();
    await upload(
      page,
      'broken.xlsx',
      Buffer.from('this is not a zip file at all'),
    );
    await expect(page.getByText('could not be read')).toBeVisible();
    await expect(page.getByTestId('sheet-preview')).toHaveCount(0);
    expect(previews).toEqual([]);
  } finally {
    await context.close();
  }
});

test('an Excel price list is saved like a CSV one and the catalog role points at it', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    await page.goto('/settings/catalog');
    await upload(page, 'tours.xlsx', agencyBook());
    await expect(counts(page)).toContainText('2 rows will be saved');
    await page.getByTestId('sheet-save').click();
    await expect(page.getByTestId('sheet-status')).toContainText(
      /: 2 rows saved/u,
    );
    const status = await page.evaluate(async () => {
      const response = await fetch('/api/v1/catalog/sheet');
      return (await response.json()) as {
        acceptedCount: number;
        sourceFilename: string;
      };
    });
    expect(status).toMatchObject({
      acceptedCount: 2,
      sourceFilename: 'tours.xlsx',
    });
  } finally {
    await context.close();
  }
});
