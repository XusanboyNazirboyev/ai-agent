import { createHmac } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { fixtures, nextClientAddress } from './helpers';

/**
 * ADR 048 end to end: an operator turns on two-step sign-in from Settings →
 * Security and then needs a code to sign in; a console admin without a second
 * factor is forced to enrol before getting a session. Codes are computed here
 * from the secret the page shows (an independent RFC 6238 implementation).
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const character of text.toUpperCase()) {
    value = (value << 5) | ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** TOTP (SHA-1, 6 digits, 30 s) for the step `stepsAhead` after now. */
function code(secret: string, stepsAhead = 0): string {
  const counter = Math.floor(Date.now() / 30_000) + stepsAhead;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret))
    .update(message)
    .digest();
  const offset = hmac[hmac.length - 1]! & 15;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

async function context(browser: Browser): Promise<Page> {
  const created = await browser.newContext({
    baseURL: 'http://127.0.0.1:3010',
    extraHTTPHeaders: { 'x-forwarded-for': nextClientAddress() },
  });
  return created.newPage();
}

test('an operator enrols from Security, then signs in with a code (and not without)', async ({
  browser,
}) => {
  const f = fixtures();
  const email = f.a.operators.mfa.email;
  const page = await context(browser);
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(f.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/inbox/u);

  await page.goto('/settings/security');
  await expect(page.getByTestId('mfa-state')).toContainText('is off');
  await page.getByTestId('mfa-start').click();
  const secret = await page.getByTestId('mfa-secret').inputValue();
  expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
  await expect(page.getByTestId('mfa-uri')).toHaveValue(
    new RegExp(`^otpauth://totp/tezda:.+secret=${secret}&issuer=tezda$`, 'u'),
  );
  await page.getByTestId('mfa-enroll-code').fill(code(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByTestId('mfa-recovery')).toBeVisible();
  await expect(
    page.getByTestId('mfa-recovery-codes').locator('li'),
  ).toHaveCount(10);
  await page.getByTestId('mfa-recovery-done').click();
  await expect(page.getByTestId('mfa-state')).toContainText('is on');

  // A fresh browser: the password alone no longer opens a session.
  const other = await context(browser);
  await other.goto('/login');
  await other.getByLabel('Email').fill(email);
  await other.getByLabel('Password').fill(f.password);
  await other.getByRole('button', { name: 'Sign in' }).click();
  await expect(other.getByTestId('mfa-form')).toBeVisible();
  await other.goto('/inbox');
  await other.waitForURL(/\/login/u);

  await other.getByLabel('Email').fill(email);
  await other.getByLabel('Password').fill(f.password);
  await other.getByRole('button', { name: 'Sign in' }).click();
  await other.getByTestId('mfa-code').fill('000000');
  await other.getByRole('button', { name: 'Verify' }).click();
  await expect(other.getByTestId('mfa-form').getByRole('alert')).toContainText(
    'not valid',
  );
  // The step used to enrol is spent (replay); the next step's code is valid.
  await other.getByTestId('mfa-code').fill(code(secret, 1));
  await other.getByRole('button', { name: 'Verify' }).click();
  await other.waitForURL(/\/inbox/u);
});

test('a console admin without a second factor must enrol before getting a session', async ({
  browser,
}) => {
  const f = fixtures();
  const page = await context(browser);
  await page.goto('/console/login');
  await page.getByLabel('Email').fill(f.platform.fresh.email);
  await page.getByLabel('Password').fill(f.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('mfa-enroll')).toBeVisible();
  await page.goto('/console');
  await page.waitForURL(/\/console\/login/u);

  await page.getByLabel('Email').fill(f.platform.fresh.email);
  await page.getByLabel('Password').fill(f.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const secret = await page.getByTestId('mfa-secret').inputValue();
  await page.getByTestId('mfa-enroll-code').fill(code(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByTestId('mfa-recovery')).toBeVisible();
  await page.getByTestId('mfa-recovery-done').click();
  await page.waitForURL(/\/console$/u);
  await page.goto('/console/security');
  await expect(page.getByTestId('mfa-state')).toContainText('is on');
  await expect(page.getByTestId('mfa-disable')).toHaveCount(0);
});
