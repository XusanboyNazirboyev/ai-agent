import http from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { FAKE_INSTAGRAM_PORT } from '../playwright.config';
import { fixtures, newSession } from './helpers';

/** A tiny graph.instagram.com: one professional account behind one token. */
const TOKEN = `test-${randomBytes(16).toString('hex')}`;
const IG_USER_ID = `1784${randomInt(10 ** 9, 10 ** 10 - 1)}`;
const USERNAME = `e2e_shop_${randomInt(10 ** 5, 10 ** 6 - 1)}`;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
/** Meta's code for an invalid or expired token (graph-api error handling). */
const META_TOKEN_EXPIRED = 190;
/** A token whose /me answer has no user_id (a malformed Meta reply). */
const NO_ID_TOKEN = `test-${randomBytes(16).toString('hex')}`;
/** A token for an account whose webhook subscription Meta refuses. */
const NO_SUBSCRIBE_TOKEN = `test-${randomBytes(16).toString('hex')}`;
const NO_SUBSCRIBE_USER_ID = `1784${randomInt(10 ** 9, 10 ** 10 - 1)}`;
const NO_SUBSCRIBE_USERNAME = `e2e_nosub_${randomInt(10 ** 5, 10 ** 6 - 1)}`;
/** Meta's code for a missing permission (graph-api error handling). */
const META_PERMISSION_MISSING = 10;
const subscribed: string[] = [];
let server: http.Server;

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake.meta');
    const reply = (status: number, payload: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    const token = url.searchParams.get('access_token');
    if (token === NO_ID_TOKEN && url.pathname === '/v26.0/me')
      return reply(HTTP_OK, { username: 'no_id' });
    if (token === NO_SUBSCRIBE_TOKEN) {
      if (url.pathname === '/v26.0/me')
        return reply(HTTP_OK, {
          user_id: NO_SUBSCRIBE_USER_ID,
          username: NO_SUBSCRIBE_USERNAME,
        });
      return reply(HTTP_BAD_REQUEST, {
        error: { code: META_PERMISSION_MISSING, type: 'OAuthException' },
      });
    }
    if (token !== TOKEN)
      return reply(HTTP_BAD_REQUEST, {
        error: { code: META_TOKEN_EXPIRED, type: 'OAuthException' },
      });
    if (request.method === 'GET' && url.pathname === '/v26.0/me')
      return reply(HTTP_OK, { user_id: IG_USER_ID, username: USERNAME });
    if (
      request.method === 'POST' &&
      url.pathname === `/v26.0/${IG_USER_ID}/subscribed_apps`
    ) {
      subscribed.push(url.searchParams.get('subscribed_fields') ?? '');
      return reply(HTTP_OK, { success: true });
    }
    return reply(HTTP_NOT_FOUND, {});
  });
  await new Promise<void>((resolve) =>
    server.listen(FAKE_INSTAGRAM_PORT, '127.0.0.1', resolve),
  );
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('an admin connects an Instagram account with its token, enables and disables it', async ({
  browser,
}) => {
  const f = fixtures();
  const admin = await newSession(browser, f.a.operators.admin.email);
  const { page } = admin;
  await page.goto('/channels');
  await page.getByTestId('connect-instagram').click();

  // A token Meta refuses is reported, and nothing is connected.
  await page
    .getByTestId('ig-connect-token')
    .fill(`test-${randomBytes(16).toString('hex')}`);
  await page.getByTestId('ig-connect-submit').click();
  await expect(page.getByTestId('ig-connect-error')).toContainText(
    'Instagram refused the request',
  );

  await page.getByTestId('ig-connect-token').fill(TOKEN);
  await page.getByTestId('ig-connect-submit').click();
  await expect(page.getByTestId('ig-connect-done')).toContainText(
    `@${USERNAME}`,
  );
  expect(await page.content()).not.toContain(TOKEN);
  await page.getByTestId('ig-connect-enable').click();

  const card = page
    .getByTestId('channel-account')
    .filter({ hasText: `@${USERNAME}` });
  await expect(card).toContainText('Active');
  expect(subscribed).toEqual(['messages']);
  // Telegram-only actions are not offered for Instagram.
  await expect(card.getByTestId('account-test')).toHaveCount(0);
  await expect(card.getByTestId('account-group')).toHaveCount(0);
  await expect(card.getByTestId('account-disconnect')).toHaveCount(0);

  await card.getByTestId('account-disable').click();
  await expect(card).toContainText('Disabled');
  await card.getByTestId('account-enable').click();
  await expect(card).toContainText('Active');
  expect(subscribed).toEqual(['messages', 'messages']);
  expect(await page.content()).not.toContain(TOKEN);
  await admin.context.close();
});

test('refuses an empty token, a /me reply without user_id, and keeps the account off when Meta refuses the subscription', async ({
  browser,
}) => {
  const f = fixtures();
  const admin = await newSession(browser, f.a.operators.admin.email);
  const { page } = admin;
  await page.goto('/channels');
  await page.getByTestId('connect-instagram').click();

  // Empty or whitespace-only: nothing can be submitted.
  await expect(page.getByTestId('ig-connect-submit')).toBeDisabled();
  await page.getByTestId('ig-connect-token').fill('   ');
  await expect(page.getByTestId('ig-connect-submit')).toBeDisabled();

  await page.getByTestId('ig-connect-token').fill(NO_ID_TOKEN);
  await page.getByTestId('ig-connect-submit').click();
  await expect(page.getByTestId('ig-connect-error')).toContainText(
    'Instagram refused the request',
  );

  await page.getByTestId('ig-connect-token').fill(NO_SUBSCRIBE_TOKEN);
  await page.getByTestId('ig-connect-submit').click();
  await expect(page.getByTestId('ig-connect-done')).toContainText(
    `@${NO_SUBSCRIBE_USERNAME}`,
  );
  await page.getByTestId('ig-connect-enable').click();
  await expect(page.getByTestId('ig-connect-error')).toContainText(
    'Instagram refused the request',
  );
  await page.getByTestId('ig-connect-later').click();
  const card = page
    .getByTestId('channel-account')
    .filter({ hasText: `@${NO_SUBSCRIBE_USERNAME}` });
  await expect(card).toContainText('Disabled');
  await admin.context.close();
});

test('an operator sees no Instagram connect button', async ({ browser }) => {
  const f = fixtures();
  const operator = await newSession(browser, f.a.operators.op1.email);
  await operator.page.goto('/channels');
  await expect(
    operator.page.getByTestId('channel-card-instagram'),
  ).toBeVisible();
  await expect(operator.page.getByTestId('connect-instagram')).toHaveCount(0);
  await operator.context.close();
});
