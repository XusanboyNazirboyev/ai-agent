import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';

test('Payme checkout uses the selected server plan and mapped locale', async ({
  browser,
}) => {
  const { page, context } = await newSession(
    browser,
    fixtures().a.operators.admin.email,
  );
  await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('uz-Latn');
  await page.route('**/api/v1/subscription', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access: { state: 'ok', periodEnd: null, graceUntil: null },
        subscription: null,
        clickConfigured: false,
        paymeConfigured: true,
        currentPlanCode: 'basic',
        plans: [
          {
            code: 'basic',
            name: 'Basic',
            priceMinor: 5_000_000,
            currency: 'UZS',
            periodDays: 30,
          },
        ],
        payments: [],
      }),
    });
  });
  let checkout: unknown;
  await page.route('**/api/v1/billing/payme/checkout', async (route) => {
    checkout = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: '/billing?paid=1' }),
    });
  });

  await page.goto('/billing');
  await expect(page.getByTestId('pay-payme')).toBeVisible();
  await expect(page.getByTestId('pay-click')).toHaveCount(0);
  await page.getByTestId('pay-payme').click();
  await expect
    .poll(() => checkout)
    .toEqual({
      planCode: 'basic',
      locale: 'uz',
    });
  await expect(page).toHaveURL(/\/billing\?paid=1$/u);
  await context.close();
});
