import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { findOverflow, fixtures, newSession } from './helpers';

// Price list upload (ADR 064). Tenant B: its admin uploads, so tenant A's
// connector roles stay as the other specs expect them.

const SAMPLE = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../docs/samples/tourism-price-list.sample.csv',
  ),
);

async function chooseFile(page: Page): Promise<void> {
  await page.getByTestId('sheet-file').setInputFiles({
    name: 'tours.csv',
    mimeType: 'text/csv',
    buffer: SAMPLE,
  });
}

test('an admin uploads a price list, checks the columns and saves it', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.b.operators.admin.email,
  );
  try {
    await page.goto('/settings/catalog');
    await expect(page.getByTestId('sheet-status')).toBeVisible();
    await expect(page.getByTestId('sheet-save')).toHaveCount(0);

    await chooseFile(page);
    // The guessed columns: price is the "Price per person" column (index 9).
    await expect(page.getByTestId('sheet-map-price')).toHaveValue('9');
    await expect(page.getByTestId('sheet-map-departureDate')).toHaveValue('7');
    await expect(page.getByTestId('sheet-counts')).toContainText('12');
    await expect(page.getByTestId('sheet-counts')).toContainText('3');
    await expect(page.getByTestId('sheet-sample-row')).toHaveCount(10);
    await expect(page.getByTestId('sheet-skipped-row')).toHaveCount(3);
    await expect(page.getByTestId('sheet-save')).toBeEnabled();

    // Without a price column nothing can be saved, and the form says why.
    await page.getByTestId('sheet-map-price').selectOption('');
    await expect(page.getByTestId('sheet-missing')).toBeVisible();
    await expect(page.getByTestId('sheet-save')).toBeDisabled();
    await page.getByTestId('sheet-map-price').selectOption('9');
    await expect(page.getByTestId('sheet-missing')).toHaveCount(0);
    await expect(page.getByTestId('sheet-save')).toBeEnabled();

    await page.getByTestId('sheet-save').click();
    await expect(page.getByTestId('sheet-bound')).toBeVisible();
    await expect(page.getByTestId('sheet-status')).toContainText('12');
    await expect(page.getByTestId('sheet-save')).toHaveCount(0);

    // The assistant's catalog role now points at the price list.
    const roles = await page.evaluate(async () => {
      const response = await fetch('/api/v1/connectors/roles');
      return (await response.json()) as {
        items: { role: string; connectorKey: string | null; status: string }[];
      };
    });
    expect(roles.items.find((r) => r.role === 'CATALOG')).toMatchObject({
      connectorKey: 'spreadsheet',
      status: 'BOUND',
    });

    // A file nobody can read is refused with a plain message and changes nothing.
    await page.getByTestId('sheet-file').setInputFiles({
      name: 'bad.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Hotel,Price,Currency\nA,abc,USD\n'),
    });
    await expect(page.getByTestId('sheet-counts')).toContainText('0');
    await expect(page.getByTestId('sheet-save')).toBeDisabled();
  } finally {
    await context.close();
  }
});

test('the price list page is for admins: the tab and the page are hidden from an operator', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.b.operators.op1.email);
  try {
    await page.goto('/settings');
    await expect(page.locator('a[href="/settings/catalog"]')).toHaveCount(0);
    await page.goto('/settings/catalog');
    await expect(page.getByTestId('sheet-file')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the upload screen has no accessibility violations and fits a phone in ru and uz-Latn', async ({
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
      {
        viewport: { width, height: 700 },
      },
    );
    try {
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await page.goto('/settings/catalog');
      await chooseFile(page);
      await expect(page.getByTestId('sheet-preview')).toBeVisible();
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
