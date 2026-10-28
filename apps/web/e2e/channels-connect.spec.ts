import http from 'node:http';
import { expect, test } from '@playwright/test';
import { FAKE_TELEGRAM_PORT } from '../playwright.config';
import { findOverflow, fixtures, newSession } from './helpers';

/** A tiny api.telegram.org: one valid bot, a webhook it remembers. */
const BOT_ID = 7_000_000_000 + Math.floor(Math.random() * 1e8);
const TOKEN = `${BOT_ID}:AAH-e2e_token_value_${'x'.repeat(20)}`;
const USERNAME = `e2e_bot_${BOT_ID}`;
let webhook = '';
let dropPending: unknown;
let server: http.Server;

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const match = /^\/bot([^/]+)\/(\w+)$/u.exec(request.url ?? '');
      const reply = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (!match || match[1] !== TOKEN)
        return reply(401, { ok: false, error_code: 401 });
      const params = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      switch (match[2]) {
        case 'getMe':
          return reply(200, {
            ok: true,
            result: {
              id: BOT_ID,
              is_bot: true,
              first_name: 'E2E bot',
              username: USERNAME,
            },
          });
        case 'setWebhook':
          webhook = String(params.url);
          dropPending = params.drop_pending_updates;
          return reply(200, { ok: true, result: true });
        case 'deleteWebhook':
          webhook = '';
          return reply(200, { ok: true, result: true });
        case 'getWebhookInfo':
          return reply(200, {
            ok: true,
            result: { url: webhook, pending_update_count: 0 },
          });
        default:
          return reply(404, { ok: false });
      }
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(FAKE_TELEGRAM_PORT, '127.0.0.1', resolve),
  );
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('an admin connects a Telegram bot with its token, enables it, checks it, sets the group and disconnects', async ({
  browser,
}) => {
  const f = fixtures();
  const admin = await newSession(browser, f.a.operators.admin.email);
  const { page } = admin;
  await page.goto('/channels');
  await page.getByTestId('connect-telegram').click();

  // A wrong token is refused without ever leaving a trace on the page.
  await page.getByTestId('connect-token').fill('not-a-token');
  await page.getByTestId('connect-submit').click();
  await expect(page.getByTestId('connect-error')).toContainText(
    'not a valid bot token',
  );
  await page
    .getByTestId('connect-token')
    .fill(`1234567:AAH-wrong_but_well_formed_${'y'.repeat(12)}`);
  await page.getByTestId('connect-submit').click();
  await expect(page.getByTestId('connect-error')).toBeVisible();

  await page.getByTestId('connect-token').fill(TOKEN);
  await page.getByTestId('connect-submit').click();
  await expect(page.getByTestId('connect-done')).toContainText(`@${USERNAME}`);
  expect(await page.content()).not.toContain(TOKEN);
  await page.getByTestId('connect-enable').click();

  const card = page
    .getByTestId('channel-account')
    .filter({ hasText: `@${USERNAME}` });
  await expect(card).toContainText('Active');
  await expect(card.getByTestId('webhook-url')).toContainText(
    'https://e2e.example.test/webhooks/telegram/',
  );
  expect(webhook).toContain('/webhooks/telegram/');
  // The first enable skips what Telegram queued while no webhook was set.
  expect(dropPending).toBe(true);
  expect(await page.content()).not.toContain(TOKEN);

  await card.getByTestId('account-test').click();
  await expect(card.getByTestId('test-result')).toContainText(
    'The bot token works',
  );
  await expect(card.getByTestId('test-result')).toContainText(
    'The webhook is registered at the right address',
  );
  await expect(card.getByTestId('test-result')).toContainText(
    'No operator group yet',
  );

  await card.getByTestId('account-group').click();
  await page.getByTestId('group-chat-id').fill('abc');
  await page.getByTestId('group-save').click();
  await expect(
    page.getByTestId('operator-group-dialog').getByRole('alert'),
  ).toContainText('chat id as a number');
  await page.getByTestId('group-chat-id').fill('-1001234567890');
  await page.getByTestId('group-save').click();
  await expect(card).toContainText('Operator group set');

  // The operator sees the account but has no controls.
  const operator = await newSession(browser, f.a.operators.op1.email);
  await operator.page.goto('/channels');
  await expect(
    operator.page
      .getByTestId('channel-account')
      .filter({ hasText: `@${USERNAME}` }),
  ).toBeVisible();
  await expect(operator.page.getByTestId('connect-telegram')).toHaveCount(0);
  await expect(operator.page.getByTestId('account-disable')).toHaveCount(0);
  await operator.context.close();

  await card.getByTestId('account-disable').click();
  await expect(card).toContainText('Disabled');
  expect(webhook).toBe('');
  // A later enable keeps queued messages unless the admin ticks the box
  // (the payload is covered by the integration test; another enable here
  // would pass the 10-calls-a-minute limit).
  await expect(card.getByTestId('account-drop-pending')).not.toBeChecked();
  await card.getByTestId('account-disconnect').click();
  await card.getByTestId('confirm-accept').click();
  await expect(card).toContainText('No bot credentials');
  await expect(card.getByTestId('account-enable')).toHaveCount(0);
  await admin.context.close();
});

test('the connect dialog fits a 320px screen', async ({ browser }) => {
  const f = fixtures();
  const admin = await newSession(browser, f.a.operators.admin.email, {
    viewport: { width: 320, height: 640 },
  });
  await admin.page.goto('/channels');
  await admin.page.getByTestId('connect-telegram').click();
  await admin.page.getByTestId('connect-token').fill('x'.repeat(150));
  expect(await findOverflow(admin.page)).toEqual([]);
  await admin.context.close();
});
