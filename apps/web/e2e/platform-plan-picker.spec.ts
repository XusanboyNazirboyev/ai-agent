import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { consoleSession, fixtures } from './helpers';

test('new customer finds an older active plan across pages and keeps the choice while searching', async ({
  browser,
}) => {
  const { page, context } = await consoleSession(
    browser,
    fixtures().platform.owner.email,
  );
  const csrf =
    (await context.cookies()).find(
      (cookie) => cookie.name === 'ac_platform_csrf',
    )?.value ?? '';
  const prefix = `picker-${randomUUID().slice(0, 8)}`;
  const ids: string[] = [];
  for (let i = 0; i < 28; i += 1) {
    const response = await page.request.post('/api/v1/platform/plans', {
      headers: { 'x-csrf-token': csrf },
      data: {
        code: `${prefix}-${i}`,
        name: `${prefix} Plan ${i}`,
        priceMinor: 100,
        periodDays: 30,
      },
    });
    expect(response.status()).toBe(201);
    ids.push(((await response.json()) as { id: string }).id);
  }
  const inactive = await page.request.patch(
    `/api/v1/platform/plans/${ids[27]}`,
    {
      headers: { 'x-csrf-token': csrf },
      data: { isActive: false },
    },
  );
  expect(inactive.ok()).toBe(true);
  await page.goto('/console');
  await page.getByTestId('new-customer').click();
  await page.getByTestId('customer-plan-search').fill(prefix);
  const picker = page.getByTestId('customer-plan');
  await expect(picker.locator('option')).toHaveCount(26); // 25 choices + no plan
  await expect(picker.locator('option').nth(1)).toHaveAttribute(
    'value',
    ids[26],
  );
  await expect(picker.locator(`option[value="${ids[27]}"]`)).toHaveCount(0);
  await expect(picker.locator(`option[value="${ids[0]}"]`)).toHaveCount(0);
  await page.getByTestId('customer-plans-more').click();
  await expect(picker.locator('option')).toHaveCount(28);
  await picker.selectOption(ids[0]);
  await page.getByTestId('customer-plan-search').fill(`${prefix}-26`);
  await expect(picker.locator('option')).toHaveCount(3); // chosen old plan + result + no plan
  await expect(picker).toHaveValue(ids[0]);
  await page.getByTestId('customer-name').fill(`Picker ${prefix}`);
  await page.getByTestId('customer-email').fill(`${prefix}@example.test`);
  const [created] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/platform/tenants',
    ),
    page.getByTestId('new-customer-submit').click(),
  ]);
  expect(created.status()).toBe(201);
  expect(created.request().postDataJSON()).toMatchObject({ planId: ids[0] });
  await expect(page.getByTestId('invite-url')).toBeVisible();
  await context.close();
});
