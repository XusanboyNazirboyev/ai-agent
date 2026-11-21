import { randomUUID } from 'node:crypto';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  consoleSession,
  fixtures,
  nextClientAddress,
  newSession,
} from './helpers';

/**
 * ADR 047 end to end: the platform console sells and controls a tenant, the
 * tenant's team accepts invites and manages itself, suspension and expiry
 * are visible to the customer, SUPPORT is read-only and the two sessions
 * never open each other's API.
 */

const BASE = 'http://127.0.0.1:3010';

async function freshContext(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { 'x-forwarded-for': nextClientAddress() },
  });
  return { context, page: await context.newPage() };
}

/** The invite link the page shows once, as a same-origin path. */
async function shownInvitePath(page: Page): Promise<string> {
  const field = page.getByTestId('invite-url');
  await expect(field).toHaveValue(/\/invite\/[A-Za-z0-9_-]+$/u);
  return new URL(await field.inputValue()).pathname;
}

async function acceptInvite(
  browser: Browser,
  path: string,
  name: string,
  password: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const session = await freshContext(browser);
  await session.page.goto(path);
  await session.page.getByTestId('invite-name').fill(name);
  await session.page.getByTestId('invite-password').fill(password);
  await session.page.getByTestId('invite-repeat').fill(password);
  await session.page.getByTestId('invite-submit').click();
  await session.page.waitForURL(/\/today/u);
  await session.page.goto('/inbox');
  return session;
}

async function tenantLogin(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function changeStatus(
  page: Page,
  action: 'suspend' | 'reactivate',
  reason: string,
): Promise<void> {
  await page.getByTestId(`tenant-${action}`).click();
  const dialog = page.getByTestId('status-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('reason-input').fill(reason);
  await dialog.getByTestId('reason-confirm').click();
  await expect(dialog).toBeHidden();
}

test('console: plan, new customer, invite, owner signs in, team, suspend and reactivate', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const f = fixtures();
  const run = randomUUID().slice(0, 8);
  const ownerEmail = `owner-${run}@example.test`;
  const ownerPassword = `owner password ${run}`;
  const operatorEmail = `operator-${run}@example.test`;
  const operatorPassword = `operator password ${run}`;
  const planName = `Start ${run}`;

  const { page: admin, context: adminContext } = await consoleSession(
    browser,
    f.platform.owner.email,
  );
  await adminContext.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: BASE,
  });

  // A plan: the price is typed in som and shown back from minor units.
  await admin.goto('/console/plans');
  await admin.getByTestId('plan-new').click();
  await admin.getByTestId('plan-code').fill(`start-${run}`);
  await admin.getByTestId('plan-name').fill(planName);
  await admin.getByTestId('plan-price-input').fill('150 000');
  await expect(admin.getByTestId('plan-dialog')).toContainText('150,000');
  await admin.getByTestId('plan-max-operators').fill('2');
  await admin.getByTestId('plan-ai-budget').fill('7.5');
  // Check the saved plan from the save response itself: the list (UI and
  // API, at most 200 rows, oldest first) can miss a new plan once leftover
  // runs have filled it, and a GET right after the click could race the save.
  const [saved] = await Promise.all([
    admin.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/platform/plans',
    ),
    admin.getByTestId('plan-save').click(),
  ]);
  expect(saved.ok()).toBeTruthy();
  const plan = (await saved.json()) as {
    id: string;
    limits: Record<string, number>;
  };
  expect(plan).toMatchObject({
    code: `start-${run}`,
    // 150 000 som typed, stored in tiyin (minor units, 2 decimals).
    priceMinor: 15_000_000,
    limits: {
      maxOperators: 2,
      monthlyLlmBudgetUsd: 7.5,
    },
  });
  expect(plan.limits).not.toHaveProperty('maxChannelAccounts');
  await expect(admin.getByTestId('plan-dialog')).toBeHidden();

  // The overview (business numbers) opens from the console nav.
  await admin.goto('/console/overview');
  await expect(admin.getByTestId('overview')).toBeVisible();
  await expect(admin.getByTestId('state-TRIAL')).toHaveAttribute(
    'href',
    '/console?subscription=TRIAL',
  );
  await expect(admin.getByTestId('kpi-paying')).toHaveAttribute(
    'href',
    '/console?subscription=ACTIVE',
  );
  await expect(admin.getByTestId('kpi-trial-soon')).toHaveAttribute(
    'href',
    '/console?subscription=TRIAL_ENDING_SOON',
  );
  await expect(admin.getByTestId('kpi-churned')).toHaveAttribute(
    'href',
    '/console?subscription=CHURNED_THIS_MONTH',
  );

  // New customer with that plan; the owner's invite link is shown once.
  await admin.goto('/console');
  await admin.getByTestId('new-customer').click();
  await admin.getByTestId('customer-name').fill(`E2E Console ${run}`);
  await expect(admin.getByTestId('customer-slug')).toHaveValue(
    `e2e-console-${run}`,
  );
  await admin.getByTestId('customer-email').fill(ownerEmail);
  const planValue = await admin
    .getByTestId('customer-plan')
    .locator('option', { hasText: planName })
    .getAttribute('value');
  await admin.getByTestId('customer-plan').selectOption(planValue ?? '');
  await admin.getByTestId('new-customer-submit').click();
  const ownerInvite = await shownInvitePath(admin);
  await admin.getByTestId('invite-copy').click();
  await expect(admin.getByTestId('invite-link')).toContainText('Copied.');
  const copied = await admin.evaluate(() => navigator.clipboard.readText());
  expect(new URL(copied).pathname).toBe(ownerInvite);
  const href = await admin.getByTestId('open-customer').getAttribute('href');
  const tenantId = href?.split('/').pop() ?? '';
  expect(tenantId).toMatch(/^[0-9a-f-]{36}$/u);
  await admin.getByTestId('dialog-done').click();
  await expect(
    admin.locator(`[data-testid="tenant-row"][data-slug="e2e-console-${run}"]`),
  ).toContainText(planName);

  // The owner accepts in a fresh browser and lands on Today as OWNER.
  const owner = await acceptInvite(
    browser,
    ownerInvite,
    'Dilnoza',
    ownerPassword,
  );
  await expect(owner.page.getByTestId('operator')).toContainText('Owner');

  // Team: invite an operator, who accepts; the owner changes the role.
  await owner.page.goto('/settings/team');
  await owner.page.getByTestId('team-invite').click();
  await owner.page.getByTestId('invite-email').fill(operatorEmail);
  await owner.page.getByTestId('invite-submit').click();
  const operatorInvite = await shownInvitePath(owner.page);
  await owner.page.getByTestId('dialog-done').click();
  await expect(owner.page.getByTestId('team-invite-row')).toContainText(
    operatorEmail,
  );
  const operator = await acceptInvite(
    browser,
    operatorInvite,
    'Jasur',
    operatorPassword,
  );
  await expect(operator.page.getByTestId('operator')).toContainText('Operator');
  await operator.context.close();

  await owner.page.reload();
  const member = owner.page.locator(
    `[data-testid="team-member"][data-email="${operatorEmail}"]`,
  );
  await member.getByTestId('member-role').selectOption('ADMIN');
  await expect(owner.page.getByTestId('confirm-dialog')).toBeVisible();
  await owner.page.getByTestId('confirm-accept').click();
  await expect(member.getByTestId('member-role')).toHaveValue('ADMIN');

  // The plan allows 2 seats: the API's limit is shown, translated.
  await owner.page.getByTestId('team-invite').click();
  await owner.page
    .getByTestId('invite-email')
    .fill(`third-${run}@example.test`);
  await owner.page.getByTestId('invite-submit').click();
  await expect(owner.page.getByTestId('invite-error')).toContainText(
    'operator limit is reached',
  );
  await owner.page.keyboard.press('Escape');

  // A blank channel limit still includes exactly one account.
  await admin.goto(`/console/tenants/${tenantId}`);
  await expect(admin.getByTestId('usage-operators')).toContainText('2 / 2');
  await expect(admin.getByTestId('usage-channels')).toContainText('0 / 1');
  await expect(admin.getByTestId('usage-ai')).toContainText('/ $7.50');

  // Suspension signs the owner out and refuses login with a clear message.
  await changeStatus(admin, 'suspend', 'e2e: unpaid invoice');
  await expect(admin.getByTestId('tenant-status')).toContainText('Suspended');
  await owner.context.close();
  const retry = await freshContext(browser);
  await tenantLogin(retry.page, ownerEmail, ownerPassword);
  await expect(
    retry.page
      .getByRole('alert')
      .filter({ hasText: 'This workspace is suspended' }),
  ).toBeVisible();

  await changeStatus(admin, 'reactivate', 'e2e: paid');
  await expect(admin.getByTestId('tenant-status')).toContainText('Active');
  await tenantLogin(retry.page, ownerEmail, ownerPassword);
  await retry.page.waitForURL(/\/today/u);
  await retry.page.goto('/inbox');
  await retry.context.close();

  // Every one of these writes is in the audit log.
  await admin.goto('/console/audit');
  await expect(admin.getByTestId('audit-row').first()).toContainText(
    'tenant.updated',
  );
  // Leave no active plan behind: the plan list holds at most 200 rows,
  // active first, and a re-run must find its own new plan among them.
  const csrf = (await adminContext.cookies()).find(
    (cookie) => cookie.name === 'ac_platform_csrf',
  )?.value;
  const retired = await admin.request.patch(
    `/api/v1/platform/plans/${plan.id}`,
    { headers: { 'x-csrf-token': csrf ?? '' }, data: { isActive: false } },
  );
  expect(retired.ok()).toBeTruthy();
  await adminContext.close();
});

test('an expired subscription shows the banner and the read-only subscription page', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.expired.owner.email);
  const banner = page.getByTestId('access-banner');
  await expect(banner).toHaveAttribute('data-state', 'expired');
  await expect(banner).toContainText('The assistant is paused');
  await expect(banner).toContainText('answer customers by hand');
  await banner.getByRole('link', { name: 'Subscription details' }).click();
  await page.waitForURL(/\/settings\/subscription/u);
  await expect(page.getByTestId('own-plan')).toHaveText(f.expired.planName);
  await expect(page.getByTestId('own-status')).toContainText('Expired');
  await expect(page.getByTestId('own-payment')).toHaveCount(1);
  await expect(page.getByTestId('own-payment')).toContainText('150,000');
  await context.close();
});

test('console: edit a customer, archive it, then delete it for good', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const f = fixtures();
  const run = randomUUID().slice(0, 8);
  const slug = `erase-${run}`;
  const { page, context } = await consoleSession(
    browser,
    f.platform.owner.email,
  );
  const csrf = (await context.cookies()).find(
    (cookie) => cookie.name === 'ac_platform_csrf',
  )?.value;
  const options = (await (
    await page.request.get('/api/v1/platform/tenants/options')
  ).json()) as { packs: string[] };
  const created = await page.request.post('/api/v1/platform/tenants', {
    headers: { 'x-csrf-token': csrf ?? '' },
    data: {
      slug,
      name: `Erase ${run}`,
      pack: options.packs[0],
      defaultLocale: 'uz-Latn',
      timezone: 'Asia/Tashkent',
      ownerEmail: `erase-${run}@example.test`,
    },
  });
  expect(created.status()).toBe(201);
  const tenantId = ((await created.json()) as { tenant: { id: string } }).tenant
    .id;

  // The list row carries the same actions as the customer page.
  await page.goto('/console');
  await page.getByTestId('tenant-search').fill(slug);
  const row = page.locator(`[data-testid="tenant-row"][data-slug="${slug}"]`);
  await expect(row.getByTestId('tenant-edit')).toBeVisible();

  await page.goto(`/console/tenants/${tenantId}`);
  await page.getByTestId('tenant-edit').click();
  const edit = page.getByTestId('tenant-edit-dialog');
  await expect(edit).toBeVisible();
  await expect(edit.getByTestId('tenant-edit-save')).toBeDisabled();
  await edit.getByTestId('tenant-edit-name').fill(`Renamed ${run}`);
  await edit.getByTestId('tenant-edit-timezone').fill('Europe/Istanbul');
  await edit.getByTestId('tenant-edit-reason').fill('owner asked');
  await edit.getByTestId('tenant-edit-save').click();
  await expect(edit).toBeHidden();
  await expect(page.getByTestId('tenant-summary')).toContainText(
    `Renamed ${run}`,
  );
  await expect(page.getByTestId('tenant-summary')).toContainText(
    'Europe/Istanbul',
  );

  // Delete is offered only for an archived customer.
  await expect(page.getByTestId('tenant-delete')).toHaveCount(0);
  await page.getByTestId('tenant-archive').click();
  const status = page.getByTestId('status-dialog');
  await status.getByTestId('reason-input').fill('test customer');
  await status.getByTestId('reason-confirm').click();
  await expect(status).toBeHidden();
  await page.getByTestId('tenant-delete').click();
  const remove = page.getByTestId('tenant-delete-dialog');
  await expect(remove).toContainText(slug);
  await remove.getByTestId('tenant-delete-slug').fill(`${slug}x`);
  await remove.getByTestId('tenant-delete-reason').fill('test customer');
  await expect(remove.getByTestId('tenant-delete-confirm')).toBeDisabled();
  await remove.getByTestId('tenant-delete-slug').fill(slug);
  await remove.getByTestId('tenant-delete-confirm').click();
  await expect(page).toHaveURL(/\/console$/u);
  await page.getByTestId('tenant-search').fill(slug);
  await expect(
    page.locator(`[data-testid="tenant-row"][data-slug="${slug}"]`),
  ).toHaveCount(0);
  expect(
    (await page.request.get(`/api/v1/platform/tenants/${tenantId}`)).status(),
  ).toBe(404);
  await context.close();
});

test('console: a password link lets a customer set a new password and sign in', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const f = fixtures();
  const run = randomUUID().slice(0, 8);
  const email = `reset-${run}@example.test`;
  const { page, context } = await consoleSession(
    browser,
    f.platform.owner.email,
  );
  const csrf = (await context.cookies()).find(
    (cookie) => cookie.name === 'ac_platform_csrf',
  )?.value;
  const options = (await (
    await page.request.get('/api/v1/platform/tenants/options')
  ).json()) as { packs: string[] };
  const created = await page.request.post('/api/v1/platform/tenants', {
    headers: { 'x-csrf-token': csrf ?? '' },
    data: {
      slug: `reset-${run}`,
      name: `Reset ${run}`,
      pack: options.packs[0],
      defaultLocale: 'uz-Latn',
      timezone: 'Asia/Tashkent',
      ownerEmail: email,
    },
  });
  expect(created.status()).toBe(201);
  const body = (await created.json()) as {
    tenant: { id: string };
    invite: { token: string };
  };
  const customer = await freshContext(browser);
  expect(
    (
      await customer.page.request.post(
        `/api/v1/auth/invites/${body.invite.token}/accept`,
        { data: { displayName: 'Owner', password: 'forgotten password 1' } },
      )
    ).status(),
  ).toBe(200);
  await customer.context.close();

  await page.goto(`/console/tenants/${body.tenant.id}`);
  await page.getByTestId('password-reset-open').first().click();
  const dialog = page.getByTestId('password-reset-dialog');
  await dialog.getByTestId('password-reset-create').click();
  await expect(dialog.getByTestId('invite-url')).toHaveValue(/\/reset\//u);
  await expect(dialog).toContainText(email);
  const link = await dialog.getByTestId('invite-url').inputValue();
  await dialog.getByTestId('dialog-done').click();

  const person = await freshContext(browser);
  await person.page.goto(new URL(link).pathname);
  await expect(person.page.getByTestId('reset-form')).toContainText(email);
  await person.page.getByTestId('reset-password').fill('brand new password');
  await person.page.getByTestId('reset-repeat').fill('brand new password');
  await person.page.getByTestId('reset-submit').click();
  await expect(person.page.getByTestId('reset-done')).toBeVisible();
  expect(
    (
      await person.page.request.post('/api/v1/auth/login', {
        data: { email, password: 'brand new password' },
      })
    ).status(),
  ).toBe(200);
  // The link works once.
  await person.page.goto(new URL(link).pathname);
  await expect(person.page.getByTestId('reset-invalid')).toBeVisible();
  await person.context.close();
  await context.close();
});

test('PLATFORM_SUPPORT sees the console read-only and the API refuses its writes', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await consoleSession(
    browser,
    f.platform.support.email,
  );
  await expect(page.getByTestId('read-only-banner')).toBeVisible();
  await expect(page.getByTestId('tenant-row').first()).toBeVisible();
  await expect(page.getByTestId('new-customer')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Admins' })).toHaveCount(0);

  await page.goto(`/console/tenants/${f.a.tenantId}`);
  await expect(page.getByTestId('tenant-summary')).toBeVisible();
  await expect(page.getByTestId('subscription-card')).toBeVisible();
  for (const id of [
    'tenant-edit',
    'tenant-suspend',
    'tenant-archive',
    'payment-record',
    'subscription-start',
    'tenant-invite',
  ])
    await expect(page.getByTestId(id)).toHaveCount(0);

  await page.goto('/console/admins');
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'You are not allowed to do this.' }),
  ).toBeVisible();

  // The API is the truth: a write with a valid session and CSRF is refused.
  const csrf = (await context.cookies()).find(
    (cookie) => cookie.name === 'ac_platform_csrf',
  )?.value;
  expect(csrf).toBeTruthy();
  const refused = await page.request.post('/api/v1/platform/plans', {
    headers: { 'x-csrf-token': csrf ?? '' },
    data: {
      code: `support-${Date.now()}`,
      name: 'x',
      priceMinor: 1,
      periodDays: 30,
    },
  });
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { code: string }).code).toBe('FORBIDDEN');
  await context.close();
});

test('a tenant session never opens the console API and a console session never opens the tenant API', async ({
  browser,
}) => {
  const f = fixtures();
  const tenant = await newSession(browser, f.a.operators.op1.email);
  for (const path of [
    '/api/v1/platform/auth/me',
    '/api/v1/platform/tenants',
    '/api/v1/platform/audit',
  ])
    expect((await tenant.page.request.get(path)).status(), path).toBe(401);
  await tenant.page.goto('/console');
  await tenant.page.waitForURL(/\/console\/login/u);
  await tenant.context.close();

  const platform = await consoleSession(browser, f.platform.owner.email);
  for (const path of [
    '/api/v1/auth/me',
    '/api/v1/inbox/conversations?scope=all',
    '/api/v1/team',
    '/api/v1/subscription',
  ])
    expect((await platform.page.request.get(path)).status(), path).toBe(401);
  await platform.page.goto('/inbox');
  await platform.page.waitForURL(/\/login/u);
  await platform.context.close();
});
