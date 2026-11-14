import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { FAKE_GOOGLE_SHEETS_PORT } from '../playwright.config';
import { findOverflow, fixtures, newSession } from './helpers';

// Price list from a Google Sheets link (ADR 064, S3). A tiny fake of
// docs.google.com is reached through GOOGLE_SHEETS_TEST_BASE_URL. Tenant B,
// like the other price list specs.

const SAMPLE = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../docs/samples/tourism-price-list.sample.csv',
  ),
  'utf8',
);
const ID = 'E2eSheetLink0123456789abcdef';
const LINK = `https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing#gid=0`;

type Mode = 'ok' | 'private' | 'moved';
let mode: Mode = 'ok';
let hits = 0;
let server: http.Server;

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    request.resume();
    if (!(request.url ?? '').startsWith(`/spreadsheets/d/${ID}/export`)) {
      response.writeHead(404).end();
      return;
    }
    hits += 1;
    if (mode === 'private') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<html>Sign in</html>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
    // A new first column: every column moves one place to the right.
    response.end(
      mode === 'moved'
        ? SAMPLE.split('\n')
            .map((line, i) => `${i === 0 ? 'Note' : 'x'},${line}`)
            .join('\n')
        : SAMPLE,
    );
  });
  await new Promise<void>((done) =>
    server.listen(FAKE_GOOGLE_SHEETS_PORT, '127.0.0.1', done),
  );
});
test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

test('an admin loads a Google Sheets link, saves it with auto refresh, reloads it, and sees each refusal', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    mode = 'ok';
    hits = 0;
    await page.goto('/settings/catalog');
    await expect(page.getByTestId('sheet-status')).toBeVisible();

    // Not a Google link: refused before anything is asked of anyone.
    await page.getByTestId('sheet-link').fill('https://evil.test/sheet');
    await page.getByTestId('sheet-link-load').click();
    await expect(page.getByTestId('sheet-link-error')).toContainText(
      'not a Google Sheets link',
    );
    expect(hits).toBe(0);

    // A private sheet: Google answers with its sign-in page.
    mode = 'private';
    await page.getByTestId('sheet-link').fill(LINK);
    await page.getByTestId('sheet-link-load').click();
    await expect(page.getByTestId('sheet-link-error')).toContainText(
      'The sheet is private',
    );
    await expect(page.getByTestId('sheet-columns')).toHaveCount(0);

    // A shared sheet: the same column check and preview as for a file.
    mode = 'ok';
    await page.getByTestId('sheet-link-load').click();
    await expect(page.getByTestId('sheet-link-error')).toHaveCount(0);
    await expect(page.getByTestId('sheet-map-price')).toHaveValue('9');
    await expect(page.getByTestId('sheet-counts')).toContainText('12');
    await expect(page.getByTestId('sheet-auto-refresh')).toBeChecked();
    await page.getByTestId('sheet-save').click();
    await expect(page.getByTestId('sheet-bound')).toBeVisible();

    const linkStatus = page.getByTestId('sheet-link-status');
    await expect(linkStatus).toContainText('Linked to Google Sheets');
    await expect(linkStatus).toContainText('every 6 hours');
    await expect(linkStatus.getByRole('link')).toHaveAttribute(
      'href',
      `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`,
    );
    await expect(page.getByTestId('sheet-refresh-error')).toHaveCount(0);

    // Reload now.
    const before = hits;
    await page.getByTestId('sheet-refresh').click();
    await expect.poll(() => hits).toBe(before + 1);
    await expect(page.getByTestId('sheet-status')).toContainText('12');
    await expect(page.getByTestId('sheet-refresh-error')).toHaveCount(0);

    // The sheet becomes private: the old list stays and the page says why.
    mode = 'private';
    await page.getByTestId('sheet-refresh').click();
    await expect(page.getByTestId('sheet-refresh-error')).toContainText(
      'The sheet is private',
    );
    await expect(page.getByTestId('sheet-status')).toContainText('12');

    // Someone inserts a column: nothing is reloaded, never a shifted price.
    mode = 'moved';
    await page.getByTestId('sheet-refresh').click();
    await expect(page.getByTestId('sheet-refresh-error')).toContainText(
      'columns of the sheet moved',
    );
    await expect(page.getByTestId('sheet-status')).toContainText('12');

    // A good reload clears the message.
    mode = 'ok';
    await page.getByTestId('sheet-refresh').click();
    await expect(page.getByTestId('sheet-refresh-error')).toHaveCount(0);

    // Uploading a file later drops the link: nothing is reloaded behind the admin's back.
    await page.getByTestId('sheet-file').setInputFiles({
      name: 'tours.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(SAMPLE),
    });
    await expect(page.getByTestId('sheet-auto-refresh')).toHaveCount(0);
    await page.getByTestId('sheet-save').click();
    await expect(page.getByTestId('sheet-bound')).toBeVisible();
    await expect(page.getByTestId('sheet-link-status')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the link form has no accessibility violations and fits a phone in ru and uz-Latn', async ({
  browser,
}) => {
  const f = fixtures();
  for (const [language, width] of [
    ['en', 1280],
    ['ru', 320],
    ['uz-Latn', 320],
  ] as const) {
    const { page, context } = await newSession(
      browser,
      f.b.operators.admin.email,
      { viewport: { width, height: 700 } },
    );
    try {
      mode = 'ok';
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await page.goto('/settings/catalog');
      await page.getByTestId('sheet-link').fill(LINK);
      await page.getByTestId('sheet-link-load').click();
      await expect(page.getByTestId('sheet-auto-refresh')).toBeVisible();
      expect(
        await findOverflow(page),
        `overflow ${language} ${width}px`,
      ).toEqual([]);
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        .analyze();
      expect(
        result.violations.map(
          (v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`,
        ),
        `axe ${language}`,
      ).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
