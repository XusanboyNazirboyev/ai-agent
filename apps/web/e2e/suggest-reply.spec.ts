import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  findOverflow,
  fixtures,
  newHandover,
  newSession,
  postAsPage,
} from './helpers';

// The "Assistant suggestion" card above the reply box (ADR 066, UX review D1).

async function openConversation(page: Page, name: string): Promise<string> {
  const item = page.getByTestId('conversation-item').filter({ hasText: name });
  await expect(item).toBeVisible();
  const id = (await item.getAttribute('data-id'))!;
  await item.click();
  await expect(page.getByTestId('suggest-ask')).toBeVisible();
  return id;
}

async function lastCustomerMessageId(page: Page, id: string): Promise<string> {
  return page.evaluate(async (conversationId) => {
    const response = await fetch(
      `/api/v1/inbox/conversations/${conversationId}`,
    );
    const view = (await response.json()) as {
      messages: { id: string; authorType: string }[];
    };
    return view.messages.filter((m) => m.authorType === 'CUSTOMER').at(-1)!.id;
  }, id);
}

const TEXT =
  'The IELTS group costs 1 250 000 UZS per person. Online or at the centre?';

test('the card shows a draft with what it looked up; edit moves it into the reply box, send puts it in the chat', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Suggest ${Date.now()}`);
  const { page, context } = await newSession(browser, f.a.operators.op1.email, {
    viewport: { width: 1440, height: 900 },
  });
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    const id = await openConversation(page, handover.contactName);
    const basedOn = await lastCustomerMessageId(page, id);
    let calls = 0;
    await page.route('**/suggest-reply', (route) => {
      calls += 1;
      return route.fulfill({
        json: {
          reply: TEXT,
          handover: null,
          toolsUsed: ['search_catalog', 'get_quote'],
          basedOnMessageId: basedOn,
        },
      });
    });

    // Nothing is suggested until asked, and the reply box stays empty.
    await expect(page.getByTestId('suggestion')).toHaveCount(0);
    await expect(page.getByTestId('reply-input')).toHaveValue('');
    await page.getByTestId('suggest-ask').click();
    const card = page.getByTestId('suggestion');
    await expect(page.getByTestId('suggest-text')).toHaveText(TEXT);
    await expect(card).toContainText('Checked the price');
    await expect(card).toContainText('Read it before you send');
    await expect(page.getByTestId('suggest-stale')).toHaveCount(0);
    // Still not in the reply box: only the card holds it.
    await expect(page.getByTestId('reply-input')).toHaveValue('');

    // Edit first: the text moves into the reply box and the card goes.
    await page.getByTestId('suggest-edit').click();
    await expect(page.getByTestId('reply-input')).toHaveValue(TEXT);
    await expect(page.getByTestId('suggestion')).toHaveCount(0);
    await page.getByTestId('reply-input').fill('');

    // Ask again, then send as it is: it appears in the conversation as ours.
    await page.getByTestId('suggest-ask').click();
    await expect(page.getByTestId('suggest-text')).toBeVisible();
    await page.getByTestId('suggest-send').click();
    await expect(page.getByTestId('timeline')).toContainText(TEXT);
    await expect(page.getByTestId('suggestion')).toHaveCount(0);
    expect(calls).toBe(2);
  } finally {
    await context.close();
  }
});

test('a suggestion for an older message says so; a hand-over gives a reason and no text; errors are plain', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Suggest2 ${Date.now()}`);
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  let mode: 'stale' | 'handover' | 'limit' = 'stale';
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    await openConversation(page, handover.contactName);
    await page.route('**/suggest-reply', (route) => {
      if (mode === 'limit')
        return route.fulfill({
          status: 429,
          json: {
            code: 'SUGGEST_RATE_LIMITED',
            i18nKey: 'errors.SUGGEST_RATE_LIMITED',
          },
        });
      return route.fulfill({
        json:
          mode === 'stale'
            ? {
                reply: TEXT,
                handover: null,
                toolsUsed: [],
                basedOnMessageId: '00000000-0000-4000-8000-000000000000',
              }
            : {
                reply: null,
                handover: 'NO_DATA',
                toolsUsed: [],
                basedOnMessageId: '00000000-0000-4000-8000-000000000000',
              },
      });
    });
    await page.getByTestId('suggest-ask').click();
    await expect(page.getByTestId('suggest-stale')).toContainText(
      'wrote again',
    );

    mode = 'handover';
    await page.getByTestId('suggest-ask').click();
    await expect(page.getByTestId('suggest-none')).toContainText(
      'no suggestion',
    );
    await expect(page.getByTestId('suggest-send')).toHaveCount(0);
    await expect(page.getByTestId('suggest-edit')).toHaveCount(0);

    mode = 'limit';
    await page.getByTestId('suggest-ask').click();
    await expect(page.getByTestId('suggest-error')).toContainText(
      'Too many suggestions',
    );

    await page.getByTestId('suggest-dismiss').click();
    await expect(page.getByTestId('suggestion')).toHaveCount(0);
    await expect(page.getByTestId('suggest-ask')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the real API drafts without writing anything, and a viewer is refused', async ({
  browser,
}) => {
  const f = fixtures();
  const handover = newHandover(f.a.tenantId, `Suggest3 ${Date.now()}`);
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  const viewer = await newSession(browser, f.a.operators.viewer.email);
  try {
    const id = await openConversation(page, handover.contactName);
    const before = await page.evaluate(async (conversationId) => {
      const response = await fetch(
        `/api/v1/inbox/conversations/${conversationId}`,
      );
      return ((await response.json()) as { messages: unknown[] }).messages
        .length;
    }, id);
    const result = await postAsPage(
      page,
      `/api/v1/inbox/conversations/${id}/suggest-reply`,
    );
    expect(result.status).toBe(200);
    // Either a text or a reason, never both.
    expect(
      (result.body.reply === null) !== (result.body.handover === null),
    ).toBe(true);
    const after = await page.evaluate(async (conversationId) => {
      const response = await fetch(
        `/api/v1/inbox/conversations/${conversationId}`,
      );
      return ((await response.json()) as { messages: unknown[] }).messages
        .length;
    }, id);
    expect(after).toBe(before);

    const refused = await postAsPage(
      viewer.page,
      `/api/v1/inbox/conversations/${id}/suggest-reply`,
    );
    expect(refused.status).toBe(403);
    // The role check answered, not a missing token.
    expect(refused.body.code).toBe('FORBIDDEN');
  } finally {
    await context.close();
    await viewer.context.close();
  }
});

test('the card has no accessibility violations and fits a phone in en, ru and uz-Latn', async ({
  browser,
}) => {
  const f = fixtures();
  for (const [language, width] of [
    ['en', 1280],
    ['ru', 320],
    ['uz-Latn', 320],
  ] as const) {
    const handover = newHandover(
      f.a.tenantId,
      `Suggest4 ${language} ${Date.now()}`,
    );
    const { page, context } = await newSession(
      browser,
      f.a.operators.op1.email,
      {
        viewport: { width, height: 700 },
      },
    );
    try {
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await page.route('**/suggest-reply', (route) =>
        route.fulfill({
          json: {
            reply: TEXT,
            handover: null,
            toolsUsed: ['get_quote'],
            basedOnMessageId: '00000000-0000-4000-8000-000000000000',
          },
        }),
      );
      await openConversation(page, handover.contactName);
      await page.getByTestId('suggest-ask').click();
      await expect(page.getByTestId('suggest-text')).toBeVisible();
      expect(
        await findOverflow(page),
        `overflow ${language} ${width}px`,
      ).toEqual([]);
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        .analyze();
      expect(
        result.violations.map(
          (v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`,
        ),
        `axe ${language}`,
      ).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
