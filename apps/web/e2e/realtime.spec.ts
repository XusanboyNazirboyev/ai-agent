import { expect, test } from '@playwright/test';
import {
  nextClientAddress,
  cookieHeader,
  customerMessage,
  fixtures,
  newHandover,
  newSession,
  readSse,
} from './helpers';

test('two browsers stay in sync: take-over, new message and new handover', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Sync ${Date.now()}`);
  const one = await newSession(browser, f.a.operators.op1.email);
  const two = await newSession(browser, f.a.operators.op2.email);
  for (const { page } of [one, two]) {
    await expect(page.getByTestId('connection')).toHaveAttribute(
      'data-state',
      'live',
    );
    await page
      .getByTestId('conversation-item')
      .filter({ hasText: handover.contactName })
      .click();
    await expect(page.getByTestId('state')).toHaveAttribute(
      'data-state',
      'WAITING_OPERATOR',
    );
  }

  await one.page.getByTestId('take-over').click();
  await expect(one.page.getByTestId('state')).toHaveAttribute(
    'data-state',
    'OPERATOR_ACTIVE',
  );
  // The other browser changes without any reload or click.
  await expect(two.page.getByTestId('state')).toHaveAttribute(
    'data-state',
    'OPERATOR_ACTIVE',
  );
  await expect(
    two.page.getByText('Another operator has this conversation.'),
  ).toBeVisible();
  await expect(two.page.getByTestId('take-over')).toHaveCount(0);
  await expect(two.page.getByTestId('reply-input')).toHaveCount(0);

  customerMessage(f.a.tenantId, handover.id, 'Are you still there?');
  await expect(two.page.getByTestId('timeline')).toContainText(
    'Are you still there?',
  );
  await expect(one.page.getByTestId('timeline')).toContainText(
    'Are you still there?',
  );

  await one.page.getByTestId('reply-input').fill('Yes, I am here');
  await one.page.getByTestId('send-reply').click();
  await expect(two.page.getByTestId('timeline')).toContainText(
    'Yes, I am here',
  );

  // A new handover appears in the waiting list of an idle browser.
  const fresh = newHandover(f.a.tenantId, `Fresh ${Date.now()}`);
  await two.page.getByRole('tab', { name: 'Waiting' }).click();
  await expect(
    two.page
      .getByTestId('conversation-item')
      .filter({ hasText: fresh.contactName }),
  ).toBeVisible();
  await one.context.close();
  await two.context.close();
});

test('two operators racing for the same conversation: exactly one wins', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Race ${Date.now()}`);
  const one = await newSession(browser, f.a.operators.op1.email);
  const two = await newSession(browser, f.a.operators.op2.email);
  for (const { page } of [one, two]) {
    await page
      .getByTestId('conversation-item')
      .filter({ hasText: handover.contactName })
      .click();
    await expect(page.getByTestId('take-over')).toBeVisible();
  }
  await Promise.all([
    one.page
      .getByTestId('take-over')
      .click()
      .catch(() => undefined),
    two.page
      .getByTestId('take-over')
      .click()
      .catch(() => undefined),
  ]);
  await expect(one.page.getByTestId('state')).toHaveAttribute(
    'data-state',
    'OPERATOR_ACTIVE',
  );
  await expect(two.page.getByTestId('state')).toHaveAttribute(
    'data-state',
    'OPERATOR_ACTIVE',
  );
  const views = await Promise.all(
    [one, two].map(
      async ({ context }) =>
        await (
          await context.request.get(
            `/api/v1/inbox/conversations/${handover.id}`,
          )
        ).json(),
    ),
  );
  expect(views[0].conversation.assignedOperatorId).toBe(
    views[1].conversation.assignedOperatorId,
  );
  const winners = await Promise.all(
    [one, two].map(async ({ page }) => page.getByTestId('reply-input').count()),
  );
  expect(winners.filter((n) => n === 1)).toHaveLength(1);
  await one.context.close();
  await two.context.close();
});

test('a stream that cannot be opened is retried and the page catches up over REST', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Blocked ${Date.now()}`);
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:3010',
    extraHTTPHeaders: { 'x-forwarded-for': nextClientAddress() },
  });
  const page = await context.newPage();
  let blocked = true;
  await page.route('**/api/v1/events', (route) =>
    blocked ? route.abort() : route.continue(),
  );
  await page.goto('/login');
  await page.getByLabel('Email').fill(f.a.operators.op2.email);
  await page.getByLabel('Password').fill(f.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/inbox/u);
  await expect(page.getByTestId('connection')).not.toHaveAttribute(
    'data-state',
    'live',
  );
  await page
    .getByTestId('conversation-item')
    .filter({ hasText: handover.contactName })
    .click();
  customerMessage(f.a.tenantId, handover.id, 'Sent while the stream was down');
  blocked = false;
  await expect(page.getByTestId('connection')).toHaveAttribute(
    'data-state',
    'live',
    { timeout: 40_000 },
  );
  await expect(page.getByTestId('timeline')).toContainText(
    'Sent while the stream was down',
  );
  await context.close();
});

test('an established stream that is closed by the server reconnects by itself and shows what was missed', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Recycle ${Date.now()}`);
  const { page, context } = await newSession(browser, f.a.operators.op2.email);
  await expect(page.getByTestId('connection')).toHaveAttribute(
    'data-state',
    'live',
  );
  await page
    .getByTestId('conversation-item')
    .filter({ hasText: handover.contactName })
    .click();
  // The e2e server closes every stream after about 6 seconds; record the states.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __states: string[] }).__states = seen;
    const target = document.querySelector('[data-testid="connection"]')!;
    new MutationObserver(() =>
      seen.push(target.getAttribute('data-state') ?? ''),
    ).observe(target, {
      attributes: true,
      attributeFilter: ['data-state'],
    });
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as unknown as { __states: string[] }).__states.includes(
            'reconnecting',
          ),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  customerMessage(f.a.tenantId, handover.id, 'Written around a reconnect');
  await expect(page.getByTestId('timeline')).toContainText(
    'Written around a reconnect',
    { timeout: 30_000 },
  );
  await expect(page.getByTestId('connection')).toHaveAttribute(
    'data-state',
    'live',
    { timeout: 30_000 },
  );
  await context.close();
});

test('falls back to periodic refresh when the server refuses the stream, then returns to live', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Poll ${Date.now()}`);
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:3010',
    extraHTTPHeaders: { 'x-forwarded-for': nextClientAddress() },
  });
  const page = await context.newPage();
  let refuse = true;
  await page.route('**/api/v1/events', (route) =>
    refuse
      ? route.fulfill({ status: 429, body: '{"code":"TOO_MANY_STREAMS"}' })
      : route.continue(),
  );
  await page.goto('/login');
  await page.getByLabel('Email').fill(f.a.operators.op2.email);
  await page.getByLabel('Password').fill(f.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/inbox/u);
  await expect(page.getByTestId('connection')).toHaveAttribute(
    'data-state',
    'polling',
  );
  await page
    .getByTestId('conversation-item')
    .filter({ hasText: handover.contactName })
    .click();
  customerMessage(f.a.tenantId, handover.id, 'Arrives by polling');
  await expect(page.getByTestId('timeline')).toContainText(
    'Arrives by polling',
    { timeout: 25_000 },
  );
  refuse = false;
  await expect(page.getByTestId('connection')).toHaveAttribute(
    'data-state',
    'live',
    { timeout: 30_000 },
  );
  await context.close();
});

test('a reconnect with Last-Event-ID replays only newer events, in order, once', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Resume ${Date.now()}`);
  const { context } = await newSession(browser, f.a.operators.op1.email);
  const cookie = await cookieHeader(context);

  const first = readSse({
    cookie,
    until: (frames) =>
      frames.some((frame) => frame.includes('event: message.created')),
    timeoutMs: 15_000,
  });
  await new Promise((r) => setTimeout(r, 1500));
  customerMessage(f.a.tenantId, handover.id, 'first-marker-message');
  const seen = await first;
  const marker = seen.find((frame) => frame.includes('event: message.created'));
  const lastId = /^id: (\d+)/mu.exec(marker ?? '')?.[1];
  expect(lastId).toBeDefined();

  customerMessage(f.a.tenantId, handover.id, 'second');
  customerMessage(f.a.tenantId, handover.id, 'third');
  const replay = await readSse({
    cookie,
    lastEventId: lastId,
    until: (frames) =>
      frames.filter((frame) => frame.includes('event: message.created'))
        .length >= 2,
    timeoutMs: 15_000,
  });
  const ids = replay
    .filter((frame) => frame.includes('event: message.created'))
    .map((frame) => BigInt(/^id: (\d+)/mu.exec(frame)![1]));
  expect(ids).toHaveLength(2);
  expect(ids.every((id) => id > BigInt(lastId!))).toBe(true);
  expect(ids[0] < ids[1]).toBe(true);
  await context.close();
});
