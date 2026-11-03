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
 * Fake Meta for Business Login: instagram.com/oauth/authorize sends the
 * browser straight back with a code (as if the person allowed access),
 * api.instagram.com/oauth/access_token buys a short-lived token with it, and
 * graph.instagram.com turns that into the long-lived token behind one account.
 */
const CODE = `code${randomBytes(12).toString('hex')}`;
const SHORT = `test-${randomBytes(16).toString('hex')}`;
const LONG = `test-${randomBytes(16).toString('hex')}`;
const IG_USER_ID = `1784${randomInt(10 ** 9, 10 ** 10 - 1)}`;
const USERNAME = `e2e_oauth_${randomInt(10 ** 5, 10 ** 6 - 1)}`;
const SCOPES = 'instagram_business_basic,instagram_business_manage_messages';
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
    const url = new URL(request.url ?? '/', 'http://fake.instagram');
    if (request.method === 'GET' && url.pathname === '/oauth/authorize') {
      authorizeSeen.push(url);
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', CODE);
      back.searchParams.set('state', url.searchParams.get('state')!);
      // Instagram appends `#_` to the redirect (Business Login docs).
      response.writeHead(302, { location: `${back.toString()}#_` });
      return response.end();
    }
    if (request.method === 'POST' && url.pathname === '/oauth/access_token') {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        const form = new URLSearchParams(body);
        if (form.get('code') !== CODE)
          return json(response, 400, {
            error_type: 'OAuthException',
            code: 400,
          });
        json(response, 200, {
          data: [
            { access_token: SHORT, user_id: IG_USER_ID, permissions: SCOPES },
          ],
        });
      });
      return;
    }
    json(response, 404, {});
  });
  await listen(FAKE_INSTAGRAM_PORT, (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake.graph');
    const token = url.searchParams.get('access_token');
    if (url.pathname === '/access_token' && token === SHORT)
      return json(response, 200, {
        access_token: LONG,
        token_type: 'bearer',
        expires_in: 5_184_000,
      });
    if (token !== LONG)
      return json(response, 400, {
        error: { code: 190, type: 'OAuthException' },
      });
    if (url.pathname === '/v26.0/me')
      return json(response, 200, { user_id: IG_USER_ID, username: USERNAME });
    if (url.pathname === `/v26.0/${IG_USER_ID}/subscribed_apps`)
      return json(response, 200, { success: true });
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

test('an admin connects Instagram with one click through Business Login, then enables it', async ({
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
  expect(authorize.searchParams.get('scope')).toBe(SCOPES);
  expect(authorize.searchParams.get('response_type')).toBe('code');
  // The single-use code and the state are gone from the address bar.
  expect(new URL(page.url()).search).toBe('');
  // Tokens never reach the page. The code is gone from the address bar and
  // the text; Next.js keeps the first URL in its render payload, which is
  // harmless: the code is single-use and worthless without the app secret.
  const html = await page.content();
  for (const token of [SHORT, LONG]) expect(html).not.toContain(token);
  expect(await page.locator('body').innerText()).not.toContain(CODE);
  expect(await findOverflow(page), 'instagram callback').toEqual([]);

  await page.getByTestId('ig-callback-enable').click();
  await expect(page.getByTestId('ig-callback-enabled')).toBeVisible();
  await page.getByTestId('ig-callback-back').click();
  await expect(page).toHaveURL(/\/channels$/u);
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
