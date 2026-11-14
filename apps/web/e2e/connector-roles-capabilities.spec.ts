import { expect, test } from '@playwright/test';
import { fixtures, newSession } from './helpers';

// A role's select offers only the connectors that can serve that role, so a
// person is not led to a choice the server then refuses (ADR 059). The API
// answers are given here, so the test does not depend on the fixture data.

const CONNECTORS = {
  secretsConfigured: true,
  items: [
    {
      id: 'c-mock',
      connectorKey: 'mock',
      status: 'ACTIVE',
      configured: false,
      capabilities: [
        'search',
        'liveQuote',
        'availability',
        'createLead',
        'updateLead',
        'createBooking',
      ],
    },
    {
      id: 'c-bitrix',
      connectorKey: 'bitrix24',
      status: 'ACTIVE',
      configured: true,
      capabilities: ['createLead'],
    },
    {
      id: 'c-sheet',
      connectorKey: 'spreadsheet',
      status: 'ACTIVE',
      configured: false,
      capabilities: ['search', 'liveQuote', 'availability'],
    },
  ],
};

const rolesAnswer = (catalog: string | null): unknown => ({
  items: [
    {
      role: 'CATALOG',
      tenantConnectorId: catalog,
      connectorKey: catalog ? 'mock' : null,
      status: catalog ? 'BOUND' : 'UNBOUND',
    },
    {
      role: 'LEAD_SINK',
      tenantConnectorId: 'c-bitrix',
      connectorKey: 'bitrix24',
      status: 'BOUND',
    },
    {
      role: 'ACTIONS',
      tenantConnectorId: 'c-bitrix',
      connectorKey: 'bitrix24',
      status: 'BOUND',
    },
  ],
});

async function optionsOf(
  page: import('@playwright/test').Page,
  role: string,
): Promise<string[]> {
  return page
    .getByTestId(`connector-role-select-${role}`)
    .locator('option')
    .allTextContents();
}

test('Catalog offers the price list and the sample catalog, not Bitrix24; leads and actions offer Bitrix24', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.owner.email,
  );
  try {
    await page.route('**/api/v1/connectors', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: CONNECTORS })
        : route.continue(),
    );
    await page.route('**/api/v1/connectors/roles', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: rolesAnswer('c-mock') })
        : route.continue(),
    );
    await page.goto('/settings/crm');
    await expect(page.getByTestId('connector-roles-section')).toBeVisible();

    const catalog = await optionsOf(page, 'CATALOG');
    expect(catalog).toContain('mock');
    expect(catalog).toContain('spreadsheet');
    expect(catalog).not.toContain('bitrix24');

    const sink = await optionsOf(page, 'LEAD_SINK');
    expect(sink).toContain('bitrix24');
    expect(sink).not.toContain('spreadsheet');

    const actions = await optionsOf(page, 'ACTIONS');
    expect(actions).toContain('bitrix24');
    expect(actions).not.toContain('spreadsheet');
  } finally {
    await context.close();
  }
});

test('a role nothing can serve says so, and points at the price list for the catalog', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.owner.email,
  );
  try {
    await page.route('**/api/v1/connectors', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            json: { secretsConfigured: true, items: [CONNECTORS.items[1]] },
          })
        : route.continue(),
    );
    await page.route('**/api/v1/connectors/roles', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: rolesAnswer(null) })
        : route.continue(),
    );
    await page.goto('/settings/crm');
    await expect(page.getByTestId('connector-role-none-CATALOG')).toBeVisible();
    await expect(page.getByTestId('connector-role-none-CATALOG')).toContainText(
      'price list',
    );
    await expect(page.getByTestId('connector-role-none-LEAD_SINK')).toHaveCount(
      0,
    );
  } finally {
    await context.close();
  }
});
