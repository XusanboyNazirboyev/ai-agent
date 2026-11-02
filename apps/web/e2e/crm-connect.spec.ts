import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { FAKE_BITRIX24_PORT } from '../playwright.config';
import { findOverflow, fixtures, newSession } from './helpers';

/**
 * A tiny Bitrix24 portal (reached through BITRIX24_TEST_BASE_URL): the
 * webhook code decides the answer to crm.settings.mode.get.
 */
const GOOD = randomBytes(8).toString('hex');
const SIMPLE = `simple${randomBytes(4).toString('hex')}`;
const urlOf = (code: string): string =>
  `https://e2e-portal.bitrix24.test/rest/1/${code}/`;
const calls: string[] = [];
let server: http.Server;

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      calls.push(request.url ?? '');
      const match =
        /^\/rest\/\d+\/([^/]+)\/crm\.settings\.mode\.get\.json$/u.exec(
          request.url ?? '',
        );
      const reply = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (!match) return reply(404, { error: 'NOT_FOUND' });
      if (match[1] === GOOD)
        return reply(200, { result: 1, time: { operating_reset_at: 1 } });
      if (match[1] === SIMPLE)
        return reply(200, { result: 2, time: { operating_reset_at: 1 } });
      return reply(401, {
        error: 'INVALID_CREDENTIALS',
        error_description: 'Invalid request credentials',
      });
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(FAKE_BITRIX24_PORT, '127.0.0.1', resolve),
  );
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('an admin connects Bitrix24 with an incoming webhook, sees each refusal, then disables and disconnects', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
  );
  await page.goto('/crm');
  const card = page.getByTestId('crm-bitrix24');
  await expect(card).toContainText('Not connected');
  await expect(page.getByTestId('crm-internal')).toContainText('Active');
  await expect(page.getByTestId('crm-soon-amocrm')).toContainText(
    'Coming soon',
  );
  await expect(page.getByTestId('crm-soon-hubspot')).toContainText(
    'Coming soon',
  );

  const field = page.getByTestId('crm-webhook-url');
  await field.fill('https://e2e-portal.bitrix24.test/not/a/webhook');
  await page.getByTestId('crm-connect').click();
  await expect(page.getByTestId('crm-error')).toContainText(
    'not a Bitrix24 incoming webhook address',
  );
  expect(calls).toHaveLength(0);

  await field.fill(urlOf(SIMPLE));
  await page.getByTestId('crm-connect').click();
  await expect(page.getByTestId('crm-error')).toContainText('simple mode');

  await field.fill(urlOf(`wrong${randomBytes(4).toString('hex')}`));
  await page.getByTestId('crm-connect').click();
  await expect(page.getByTestId('crm-error')).toContainText(
    'Bitrix24 refused this address',
  );

  await field.fill(urlOf(GOOD));
  await page.getByTestId('crm-connect').click();
  await expect(card).toContainText('Active');
  await expect(page.getByTestId('crm-disable')).toBeVisible();
  expect(calls.at(-1)).toBe(`/rest/1/${GOOD}/crm.settings.mode.get.json`);
  // The address is never sent back to the page.
  expect(await page.content()).not.toContain(GOOD);
  await page.reload();
  await expect(card).toContainText('Active');
  expect(await page.content()).not.toContain(GOOD);
  expect(await findOverflow(page), 'crm connected').toEqual([]);

  await page.getByTestId('crm-disable').click();
  await expect(card).toContainText('Disabled');
  await expect(page.getByTestId('crm-webhook-url')).toBeVisible();

  // Connect again, then disconnect for good.
  await page.getByTestId('crm-webhook-url').fill(urlOf(GOOD));
  await page.getByTestId('crm-connect').click();
  await expect(card).toContainText('Active');
  await page.getByTestId('crm-disconnect').click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Disconnect' })
    .click();
  await expect(card).toContainText('Not connected');
  await context.close();
});

test('an operator sees that only owners and admins manage CRM connections', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email, {
    viewport: { width: 320, height: 800 },
  });
  await page.goto('/crm');
  await expect(page.getByTestId('crm-admin-only')).toBeVisible();
  await expect(page.getByTestId('crm-bitrix24')).toHaveCount(0);
  expect(await findOverflow(page), 'crm operator 320').toEqual([]);
  await context.close();
});
