import { expect, test } from '@playwright/test';
import { cookieHeader, fixtures, login, newSession } from './helpers';

test('rejects bad credentials with the same message and keeps the user on the form', async ({
  page,
}) => {
  const f = fixtures();
  await page.goto('/login');
  await page.getByLabel('Email').fill(f.a.operators.op1.email);
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Invalid' }),
  ).toHaveText('Invalid email or password.');
  await page.getByLabel('Email').fill('nobody@example.test');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Invalid' }),
  ).toHaveText('Invalid email or password.');
  await expect(page).toHaveURL(/\/login/u);
});

test('sets an httpOnly SameSite=Strict session cookie and a readable CSRF cookie', async ({
  page,
  context,
}) => {
  const f = fixtures();
  await login(page, f.a.operators.op1.email, f.password);
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === 'ac_session');
  const csrf = cookies.find((c) => c.name === 'ac_csrf');
  expect(session).toMatchObject({
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
  });
  expect(csrf).toMatchObject({ httpOnly: false, sameSite: 'Strict' });
  // The page script can read the CSRF cookie but never the session cookie.
  const visible = await page.evaluate(() => document.cookie);
  expect(visible).toContain('ac_csrf=');
  expect(visible).not.toContain('ac_session');
});

test('sends unauthenticated visitors to the login page and API calls get 401', async ({
  page,
  request,
}) => {
  await page.goto('/inbox');
  await expect(page).toHaveURL(/\/login/u);
  const response = await request.get('/api/v1/inbox/conversations');
  expect(response.status()).toBe(401);
  expect((await response.json()).code).toBe('UNAUTHENTICATED');
});

test('logging out ends the session everywhere', async ({ browser }) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  const cookie = await cookieHeader(context);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/u);
  const after = await context.request.get('/api/v1/auth/me');
  expect(after.status()).toBe(401);
  // The old cookie value is dead on the server, not just cleared in the browser.
  const replay = await fetch('http://127.0.0.1:3010/api/v1/auth/me', {
    headers: { cookie },
  });
  expect(replay.status).toBe(401);
  await page.goto('/inbox');
  await expect(page).toHaveURL(/\/login/u);
  await context.close();
});

test('refuses state changes without the CSRF token or from a foreign origin', async ({
  browser,
}) => {
  const f = fixtures();
  const { context } = await newSession(browser, f.a.operators.op1.email);
  const target = f.a.conversations[1].handoverId;
  const csrf = (await context.cookies()).find(
    (c) => c.name === 'ac_csrf',
  )!.value;
  const headers = { 'idempotency-key': 'e2e-csrf-key-1' };
  const noToken = await context.request.post(
    `/api/v1/handovers/${target}/take-over`,
    { headers },
  );
  expect(noToken.status()).toBe(403);
  expect((await noToken.json()).code).toBe('CSRF');
  const wrongToken = await context.request.post(
    `/api/v1/handovers/${target}/take-over`,
    {
      headers: { ...headers, 'x-csrf-token': 'not-the-token' },
    },
  );
  expect(wrongToken.status()).toBe(403);
  const foreign = await context.request.post(
    `/api/v1/handovers/${target}/take-over`,
    {
      headers: {
        ...headers,
        'x-csrf-token': csrf,
        origin: 'https://evil.example',
      },
    },
  );
  expect(foreign.status()).toBe(403);
  expect((await foreign.json()).code).toBe('BAD_ORIGIN');
  const view = await context.request.get(
    `/api/v1/inbox/conversations/${f.a.conversations[1].id}`,
  );
  expect((await view.json()).conversation.state).toBe('WAITING_OPERATOR');
  await context.close();
});
