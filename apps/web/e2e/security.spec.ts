import {
  expect,
  request as playwrightRequest,
  test,
  type Page,
} from '@playwright/test';
import { fixtures, newSession, nextClientAddress } from './helpers';

const BASE = 'http://127.0.0.1:3010';

/**
 * Attack attempts use an unknown email so the per-account lockout (a separate
 * control) never interferes with what is measured here: the per-client limit.
 */
async function loginStatus(
  headers: Record<string, string>,
  credentials = {
    email: 'attacker-target@example.test',
    password: 'wrong-password',
  },
): Promise<number> {
  const context = await playwrightRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: headers,
  });
  const response = await context.post('/api/v1/auth/login', {
    data: credentials,
  });
  const status = response.status();
  await context.dispose();
  return status;
}

test.describe('login rate limit through the real web server', () => {
  test('one client exhausting its budget does not lock out another client', async () => {
    const attacker = nextClientAddress();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1)
      statuses.push(await loginStatus({ 'x-forwarded-for': attacker }));
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    // A different client still signs in with the right password.
    expect(
      await loginStatus(
        { 'x-forwarded-for': nextClientAddress() },
        {
          email: fixtures().b.operators.op1.email,
          password: fixtures().password,
        },
      ),
    ).toBe(200);
  });

  test('spoofed forwarding and boundary headers do not give a new budget', async () => {
    const attacker = nextClientAddress();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1)
      statuses.push(
        await loginStatus({
          // The client controls everything left of what the edge appended.
          'x-forwarded-for': `203.0.113.${i}, 192.0.2.${i}, ${attacker}`,
          'x-real-ip': `203.0.113.${i}`,
          forwarded: `for=203.0.113.${i}`,
          'x-agentcore-client-ip': `203.0.113.${i}`,
          'x-agentcore-proxy-auth': 'guessed-secret',
        }),
      );
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

test.describe('nonce-based Content-Security-Policy', () => {
  test('every page response carries a fresh nonce and no inline-script allowance', async ({
    request,
  }) => {
    const policies: string[] = [];
    for (const path of ['/login', '/login', '/inbox']) {
      const response = await request.get(path);
      const policy = response.headers()['content-security-policy'];
      expect(policy, path).toBeTruthy();
      policies.push(policy);
      const scriptSrc = policy
        .split(';')
        .find((d) => d.trim().startsWith('script-src'))!;
      expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]{20,}'/u);
      expect(scriptSrc).toContain("'strict-dynamic'");
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(scriptSrc).not.toContain("'unsafe-eval'");
      expect(policy).not.toMatch(/style-src[^;]*'unsafe-inline'/u);
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("frame-ancestors 'none'");
      // Every script element in the HTML carries this response's nonce.
      const nonce = /'nonce-([^']+)'/u.exec(scriptSrc)![1];
      const html = await response.text();
      const scripts = [...html.matchAll(/<script\b[^>]*>/gu)].map((m) => m[0]);
      expect(scripts.length, path).toBeGreaterThan(0);
      for (const tag of scripts)
        expect(tag, path).toContain(`nonce="${nonce}"`);
    }
    const nonces = policies.map((p) => /'nonce-([^']+)'/u.exec(p)![1]);
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  async function recordViolations(page: Page): Promise<string[]> {
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy|Refused to/iu.test(message.text()))
        violations.push(message.text());
    });
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        console.error(
          `Refused to ... CSP violation: ${event.violatedDirective} ${event.blockedURI}`,
        );
      });
    });
    return violations;
  }

  test('the application works under the policy without a single violation', async ({
    browser,
  }) => {
    const f = fixtures();
    const context = await browser.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { 'x-forwarded-for': nextClientAddress() },
    });
    const page = await context.newPage();
    const violations = await recordViolations(page);
    await page.goto('/login');
    await page.getByLabel('Email').fill(f.a.operators.op1.email);
    await page.getByLabel('Password').fill(f.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/inbox/u);
    await page.getByTestId('conversation-item').first().click();
    await expect(page.getByTestId('conversation-view')).toBeVisible();
    await expect(page.getByTestId('connection')).toHaveAttribute(
      'data-state',
      'live',
    );
    await page.getByLabel('Language', { exact: true }).selectOption('ru');
    await page.reload();
    await expect(page.getByTestId('conversation-view')).toBeVisible();
    expect(violations).toEqual([]);
    await context.close();
  });

  test('an injected inline script without the nonce is blocked while the app keeps working', async ({
    browser,
  }) => {
    const f = fixtures();
    const { context } = await newSession(browser, f.a.operators.op1.email);
    const page = await context.newPage();
    const violations = await recordViolations(page);
    await page.route('**/inbox', async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace(
        '</body>',
        '<script>window.__injected = true</script><div id="injected-marker"></div></body>',
      );
      await route.fulfill({ response, body: html });
    });
    await page.goto('/inbox');
    await expect(page.locator('#injected-marker')).toHaveCount(1);
    expect(
      await page.evaluate(
        () => (window as unknown as { __injected?: boolean }).__injected,
      ),
    ).toBeUndefined();
    expect(violations.some((v) => /script-src/u.test(v))).toBe(true);
    // The legitimate, nonce-carrying scripts ran: the inbox is interactive.
    await expect(page.getByTestId('conversation-list')).toBeVisible();
    await context.close();
  });
});
