import http from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  E2E_ENV,
  FAKE_INSTAGRAM_OAUTH_PORT,
  FAKE_INSTAGRAM_PORT,
} from '../playwright.config';
import { findOverflow, fixtures, newSession } from './helpers';

/**
 * Fake Meta for Instagram API with Unified login: the login dialog sends the
 * browser straight back with a code (as if the client chose an account),
 * the Graph API exchanges it for a system-user token only with the exact
 * documented parameters and lists the one shared Instagram account. The
 * retired instagram.com / api.instagram.com endpoints answer 404.
 */
const CODE = `code${randomBytes(12).toString('hex')}`;
const SYSTEM_TOKEN = `test-${randomBytes(16).toString('hex')}`;
const IG_USER_ID = `1784${randomInt(10 ** 9, 10 ** 10 - 1)}`;
const USERNAME = `e2e_oauth_${randomInt(10 ** 5, 10 ** 6 - 1)}`;
const GRAPH_PATH = new URL(E2E_ENV.INSTAGRAM_API_BASE_URL).pathname;
const authorizeSeen: URL[] = [];
const servers: http.Server[] = [];

const json = (
  response: http.ServerResponse,
  status: number,
  payload: unknown,
): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
};

function listen(port: number, handler: http.RequestListener): Promise<void> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

test.beforeAll(async () => {
  await listen(FAKE_INSTAGRAM_OAUTH_PORT, (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake.facebook');
    if (request.method === 'GET' && url.pathname === '/dialog/oauth') {
      authorizeSeen.push(url);
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', CODE);
      back.searchParams.set('state', url.searchParams.get('state')!);
      response.writeHead(302, { location: back.toString() });
      return response.end();
    }
    json(response, 404, {});
  });
  await listen(FAKE_INSTAGRAM_PORT, (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake.graph');
    const q = url.searchParams;
    if (
      request.method === 'GET' &&
      url.pathname === `${GRAPH_PATH}/oauth/access_token`
    ) {
      const exact =
        q.get('client_id') === E2E_ENV.INSTAGRAM_APP_ID &&
        // The config module draws a fresh random secret per process, so the
        // worker cannot know the API's value; it must be present, server side.
        /^[0-9a-f]{32}$/u.test(q.get('client_secret') ?? '') &&
        q.get('redirect_uri') === E2E_ENV.INSTAGRAM_OAUTH_REDIRECT_URI &&
        q.get('code') === CODE;
      return exact
        ? json(response, 200, { access_token: SYSTEM_TOKEN })
        : json(response, 400, { error: { code: 100, type: 'OAuthException' } });
    }
    if (
      request.method === 'GET' &&
      url.pathname === `${GRAPH_PATH}/me/assigned_instagram_accounts` &&
      q.get('access_token') === SYSTEM_TOKEN
    )
      return json(response, 200, {
        data: [{ id: IG_USER_ID, username: USERNAME }],
      });
    if (
      request.method === 'POST' &&
      url.pathname === `${GRAPH_PATH}/${IG_USER_ID}/subscribed_apps`
    ) {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        const form = new URLSearchParams(body);
        if (
          form.get('access_token') === SYSTEM_TOKEN &&
          form.get('subscribed_fields') === 'messages'
        )
          return json(response, 200, { success: true });
        json(response, 400, { error: { code: 190 } });
      });
      return;
    }
    json(response, 404, {});
  });
});
test.afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

test('an admin connects Instagram with one click through Unified login, then enables it', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.owner.email,
  );
  await page.goto('/channels');
  await page.getByTestId('connect-instagram').click();
  // No token to find: the token form is folded away behind the fallback.
  await expect(page.getByTestId('ig-connect-token')).toHaveCount(0);
  await page.getByTestId('ig-oauth-start').click();

  await expect(page.getByTestId('ig-callback-done')).toContainText(
    `@${USERNAME}`,
  );
  const authorize = authorizeSeen.at(-1)!;
  expect(authorize.searchParams.get('client_id')).toBe(
    E2E_ENV.INSTAGRAM_APP_ID,
  );
  expect(authorize.searchParams.get('config_id')).toBe(
    E2E_ENV.INSTAGRAM_LOGIN_CONFIG_ID,
  );
  expect(authorize.searchParams.get('response_type')).toBe('code');
  expect(authorize.searchParams.has('scope')).toBe(false);
  // The single-use code and the state are gone from the address bar.
  expect(new URL(page.url()).search).toBe('');
  // Tokens never reach the page. The code is gone from the address bar and
  // the text; Next.js keeps the first URL in its render payload, which is
  // harmless: the code is single-use and worthless without the app secret.
  const html = await page.content();
  expect(html).not.toContain(SYSTEM_TOKEN);
  expect(html).not.toContain('client_secret');
  expect(await page.locator('body').innerText()).not.toContain(CODE);
  expect(await findOverflow(page), 'instagram callback').toEqual([]);

  await page.getByTestId('ig-callback-enable').click();
  await expect(page.getByTestId('ig-callback-enabled')).toBeVisible();
  await page.getByTestId('ig-callback-back').click();
  await expect(page).toHaveURL(/\/settings\/channels$/u);
  await expect(
    page.getByTestId('channel-account').filter({ hasText: `@${USERNAME}` }),
  ).toBeVisible();
  await context.close();
});

test('the callback page explains a refusal, a stray visit and a state from elsewhere', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.owner.email,
  );

  await page.goto(
    '/channels/instagram/callback?error=access_denied&error_reason=user_denied',
  );
  await expect(page.getByTestId('ig-callback-denied')).toContainText(
    'Access was not allowed',
  );

  await page.goto('/channels/instagram/callback');
  await expect(page.getByTestId('ig-callback-denied')).toContainText(
    'Start again from the Channels page',
  );

  await page.goto(
    `/channels/instagram/callback?code=${CODE}&state=forged-state`,
  );
  await expect(page.getByTestId('ig-callback-error')).toContainText(
    'expired or belongs to another session',
  );
  await context.close();
});
