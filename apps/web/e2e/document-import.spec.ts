import { expect, test } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { fixtures, newSession } from './helpers';

const ROWS = [
  ['Product', 'Price', 'Currency', 'Stock'],
  ['Oak desk', '125', 'USD', '4'],
  ['Pine chair', '75', 'USD', '0'],
];
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function docx(rows: string[][]): Buffer {
  const p = (value: string): string =>
    `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`;
  const table = rows
    .map(
      (row) =>
        `<w:tr>${row.map((cell) => `<w:tc>${p(cell)}</w:tc>`).join('')}</w:tr>`,
    )
    .join('');
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      '_rels/.rels': strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
      'word/document.xml': strToU8(
        `<w:document xmlns:w="${WORD_NS}"><w:body>${p('Yetkazish qoidalari: yig‘ish alohida.')}${table ? `<w:tbl>${table}</w:tbl>` : ''}</w:body></w:document>`,
      ),
    }),
  );
}

function pdf(rows: string[][]): Buffer {
  const text = rows
    .flatMap((row, line) =>
      row.map(
        (cell, column) =>
          `BT /F1 11 Tf 1 0 0 1 ${48 + column * 115} ${740 - line * 22} Tm (${cell}) Tj ET\n`,
      ),
    )
    .join('');
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}endstream`,
  ];
  let source = '%PDF-1.4\n';
  const offsets = bodies.map((body, index) => {
    const offset = source.length;
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  return Buffer.from(
    `${source}xref\n0 6\n0000000000 65535 f \n${offsets.join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${source.length}\n%%EOF\n`,
  );
}

const files = [
  {
    extension: 'docx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    policy: docx([]),
    policyText: 'Yetkazish qoidalari: yig‘ish alohida.',
    prices: docx(ROWS),
    invalid: docx([ROWS[0]!, ROWS[1]!.slice(0, 2), ROWS[2]!]),
  },
  {
    extension: 'pdf',
    mimeType: 'application/pdf',
    policy: pdf([['Delivery starts on weekdays.']]),
    policyText: 'Delivery starts on weekdays.',
    prices: pdf(ROWS),
    invalid: pdf([ROWS[0]!, ROWS[1]!.slice(0, 2), ROWS[2]!]),
  },
];

for (const {
  extension,
  mimeType,
  policy,
  prices,
  policyText,
  invalid,
} of files) {
  test(`imports ${extension} knowledge and validates its prices before saving`, async ({
    browser,
  }) => {
    const f = fixtures();
    const { page, context } = await newSession(
      browser,
      f.b.operators.admin.email,
    );
    try {
      await page.goto('/agent/knowledge');
      await page.getByTestId('knowledge-tab-documents').click();
      await page.getByTestId('document-upload').click();
      if (extension === 'pdf') {
        await page
          .getByTestId('document-file')
          .setInputFiles({ name: 'no-text.pdf', mimeType, buffer: pdf([]) });
        await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
          'No selectable text',
        );
        await expect(page.getByTestId('document-save')).toBeDisabled();
      }
      const title = `Import policy ${extension} ${Date.now()}`;
      await page.getByTestId('document-file').setInputFiles({
        name: `${title}.${extension}`,
        mimeType,
        buffer: policy,
      });
      await expect(page.getByTestId('document-text')).toHaveValue(policyText);
      await expect(page.getByTestId('document-save')).toBeDisabled();
      await page.getByTestId('document-consent').check();
      await page.getByTestId('document-save').click();
      await expect(
        page.getByTestId('document-item').filter({ hasText: title }),
      ).toBeVisible();

      await page.goto('/agent/prices');
      await expect(page.getByTestId('sheet-status')).toBeVisible();
      const input = page.getByTestId('sheet-file');
      await input.setInputFiles({
        name: `prices.${extension}`,
        mimeType,
        buffer: prices,
      });
      await expect(page.getByTestId('sheet-sample-row')).toHaveCount(2);
      await expect(page.getByTestId('sheet-sample-row').first()).toContainText(
        '125',
      );
      await expect(page.getByTestId('sheet-sample-row').last()).toContainText(
        'Pine chair',
      );

      await input.setInputFiles({
        name: `prices.${extension}`,
        mimeType,
        buffer: invalid,
      });
      await expect(page.getByTestId('sheet-file-error')).toContainText(
        'regular price table',
      );
      await expect(page.getByTestId('sheet-save')).toHaveCount(0);

      await input.setInputFiles({
        name: `prices.${extension}`,
        mimeType,
        buffer: prices,
      });
      await page.getByTestId('sheet-pricing-basis').selectOption('PER_UNIT');
      await page.getByTestId('sheet-save').click();
      await expect(page.getByTestId('sheet-bound')).toBeVisible();
      const saved = await page.evaluate(async () => {
        const response = await fetch('/api/v1/catalog/sheet');
        return (await response.json()) as {
          acceptedCount: number;
          sourceFilename: string;
        };
      });
      expect(saved).toMatchObject({
        sourceFilename: `prices.${extension}`,
        acceptedCount: 2,
      });
    } finally {
      await context.close();
    }
  });
}
