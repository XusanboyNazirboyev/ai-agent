import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Public privacy policy, data deletion and terms pages (ADR 035 step 2):
// Meta's app settings need them reachable without signing in.

const TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
  'best-practice',
];

test('the privacy and data deletion pages open signed out, in every language, with the draft marked', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Privacy policy' }).click();
  await expect(page).toHaveURL(/\/privacy$/u);
  const privacy = page.getByTestId('privacy-page');
  await expect(
    privacy.getByRole('heading', { level: 1, name: 'Privacy policy' }),
  ).toBeVisible();
  await expect(privacy.getByRole('note')).toContainText(
    'Draft for legal review',
  );
  // Company details are open (P4): visible placeholders, never invented.
  await expect(privacy.getByTestId('legal-placeholder').first()).toHaveText(
    '[to be provided]',
  );
  await expect(privacy).toContainText('Frankfurt');
  await expect(privacy).toContainText('7 days');

  await page.getByLabel('Language', { exact: true }).selectOption('ru');
  await expect(
    privacy.getByRole('heading', {
      level: 1,
      name: 'Политика конфиденциальности',
    }),
  ).toBeVisible();
  await page.getByLabel('Язык', { exact: true }).selectOption('uz-Latn');
  await expect(
    privacy.getByRole('heading', { level: 1, name: 'Maxfiylik siyosati' }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Ma’lumotlarni o‘chirish' }).click();
  await expect(page).toHaveURL(/\/data-deletion$/u);
  await expect(
    page
      .getByTestId('data-deletion-page')
      .getByRole('heading', { level: 1, name: 'Ma’lumotlarni o‘chirish' }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Foydalanish shartlari' }).click();
  await expect(page).toHaveURL(/\/terms$/u);
  const terms = page.getByTestId('terms-page');
  await expect(
    terms.getByRole('heading', { level: 1, name: 'Foydalanish shartlari' }),
  ).toBeVisible();
  // Governing law is the lawyer's decision: a placeholder, never invented.
  await expect(terms.getByTestId('legal-placeholder').first()).toBeVisible();
});

for (const path of ['/privacy', '/data-deletion', '/terms'])
  test(`${path} has no accessibility violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(
      result.violations.map((violation) => violation.id),
      path,
    ).toEqual([]);
  });
