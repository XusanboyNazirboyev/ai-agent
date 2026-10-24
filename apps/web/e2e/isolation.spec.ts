import { expect, test } from '@playwright/test';
import {
  cookieHeader,
  customerMessage,
  fixtures,
  newHandover,
  newSession,
  readSse,
} from './helpers';

test('tenant A never reaches tenant B through the API, search, commands or direct URLs', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  const foreign = f.b.conversations[0];
  const csrf = (await context.cookies()).find(
    (c) => c.name === 'ac_csrf',
  )!.value;

  // Direct read of another tenant's conversation: not found, no data.
  const view = await context.request.get(
    `/api/v1/inbox/conversations/${foreign.id}`,
  );
  expect(view.status()).toBe(404);
  expect(await view.text()).not.toContain(foreign.contactName);

  // Lists, every scope, and search never include it.
  for (const scope of ['waiting', 'mine', 'all', 'closed']) {
    const list = await context.request.get(
      `/api/v1/inbox/conversations?scope=${scope}&limit=50`,
    );
    expect(await list.text()).not.toContain(foreign.id);
  }
  const bName = foreign.contactName.split(' ').pop()!;
  const byName = await context.request.get(
    `/api/v1/inbox/conversations?scope=all&q=${encodeURIComponent(bName)}`,
  );
  expect((await byName.json()).items).toEqual([]);
  const byText = await context.request.get(
    `/api/v1/inbox/conversations?scope=all&q=${encodeURIComponent('Hello from b one')}`,
  );
  expect((await byText.json()).items).toEqual([]);

  // Commands against another tenant's handover are refused as not found, state untouched.
  for (const action of ['take-over', 'close', 'return-to-bot']) {
    const response = await context.request.post(
      `/api/v1/handovers/${foreign.handoverId}/${action}`,
      {
        headers: {
          'x-csrf-token': csrf,
          'idempotency-key': `e2e-iso-${action}-key`,
        },
      },
    );
    expect(response.status(), action).toBe(404);
  }
  const reply = await context.request.post(
    `/api/v1/handovers/${foreign.handoverId}/reply`,
    {
      headers: { 'x-csrf-token': csrf, 'idempotency-key': 'e2e-iso-reply-key' },
      data: { text: 'should never be sent' },
    },
  );
  expect(reply.status()).toBe(404);

  // The UI shows an error, not tenant B's data, for a pasted foreign URL.
  await page.goto(`/inbox?c=${foreign.id}`);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(foreign.contactName);

  // Operators of tenant B still see their own conversation untouched.
  const b = await newSession(browser, f.b.operators.op1.email);
  await expect(b.page.getByTestId('conversation-item')).toHaveCount(1);
  await b.page.getByTestId('conversation-item').click();
  await expect(b.page.getByTestId('state')).toHaveAttribute(
    'data-state',
    'WAITING_OPERATOR',
  );
  await b.context.close();
  await context.close();
});

test('the event stream of tenant A never carries tenant B events', async ({
  browser,
}) => {
  const f = fixtures();
  const { context } = await newSession(browser, f.a.operators.op1.email);
  const cookie = await cookieHeader(context);
  const handoverA = newHandover(f.a.tenantId, `IsoA ${Date.now()}`);
  const stream = readSse({
    cookie,
    until: (frames) =>
      frames.filter((frame) => frame.includes('event: message.created'))
        .length >= 1,
    timeoutMs: 20_000,
  });
  await new Promise((r) => setTimeout(r, 1500));
  customerMessage(f.b.tenantId, f.b.conversations[0].id, 'B only');
  newHandover(f.b.tenantId, `IsoB ${Date.now()}`);
  customerMessage(f.a.tenantId, handoverA.id, 'A marker');
  const frames = await stream;
  const joined = frames.join('\n');
  expect(joined).toContain(handoverA.id);
  expect(joined).not.toContain(f.b.conversations[0].id);
  await context.close();
});

test('a viewer can read but cannot act, in the UI or directly', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Viewer ${Date.now()}`);
  const { page, context } = await newSession(
    browser,
    f.a.operators.viewer.email,
  );
  await page
    .getByTestId('conversation-item')
    .filter({ hasText: handover.contactName })
    .click();
  await expect(page.getByTestId('state')).toHaveAttribute(
    'data-state',
    'WAITING_OPERATOR',
  );
  await expect(page.getByTestId('take-over')).toHaveCount(0);
  await expect(page.getByTestId('reply-input')).toHaveCount(0);
  const csrf = (await context.cookies()).find(
    (c) => c.name === 'ac_csrf',
  )!.value;
  const response = await context.request.post(
    `/api/v1/handovers/${handover.handoverId}/take-over`,
    {
      headers: { 'x-csrf-token': csrf, 'idempotency-key': 'e2e-viewer-key-1' },
    },
  );
  expect(response.status()).toBe(403);
  const after = await context.request.get(
    `/api/v1/inbox/conversations/${handover.id}`,
  );
  expect((await after.json()).conversation.state).toBe('WAITING_OPERATOR');
  await context.close();
});

test('an operator session cannot be replayed from another tenant’s credentials', async ({
  browser,
}) => {
  const f = fixtures();
  const a = await newSession(browser, f.a.operators.op1.email);
  const b = await newSession(browser, f.b.operators.op1.email);
  const me = await (await b.context.request.get('/api/v1/auth/me')).json();
  expect(me.operator.id).toBe(f.b.operators.op1.id);
  const mine = await (await a.context.request.get('/api/v1/auth/me')).json();
  expect(mine.operator.id).toBe(f.a.operators.op1.id);
  await a.context.close();
  await b.context.close();
});
