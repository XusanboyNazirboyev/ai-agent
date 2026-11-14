import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { findOverflow, fixtures, newSession, postAsPage } from './helpers';

// Test chat (ADR 065, UX review C3): try the assistant without a customer.

async function conversationIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const response = await fetch(
      '/api/v1/inbox/conversations?scope=all&limit=25',
    );
    const body = (await response.json()) as { items?: { id: string }[] };
    if (!response.ok) throw new Error(`list failed ${response.status}`);
    return (body.items ?? []).map((item) => item.id).sort();
  });
}

const FAKE = {
  reply: 'IELTS Preparation: 1 250 000 UZS per person.',
  outcome: 'ANSWERED',
  handover: 'NO_DATA',
  language: 'en',
  script: 'Latn',
  slots: { subject: { value: 'IELTS', source: 'customer' } },
  toolsUsed: ['search_catalog', 'get_quote', 'book_slot'],
  askedSlot: null,
};

test('an admin chats with the real assistant and nothing is saved anywhere', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
  );
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    await page.goto('/settings/bot');
    // The assistant page offers it.
    await page.getByTestId('bot-try').click();
    await page.waitForURL(/\/settings\/bot\/test/u);
    const before = await conversationIds(page);

    await expect(page.getByTestId('test-chat-starter-hello')).toBeVisible();
    await page.getByTestId('test-chat-starter-hello').click();
    await expect(page.getByTestId('test-chat-customer')).toContainText('Hello');
    // Whatever the assistant decides, it answers in the chat (a reply or a hand-over note).
    await expect(page.getByTestId('test-chat-assistant')).toBeVisible({
      timeout: 60_000,
    });

    await page.getByTestId('test-chat-input').fill('How much does it cost?');
    await page.getByTestId('test-chat-input').press('Enter');
    await expect(page.getByTestId('test-chat-customer')).toHaveCount(2);
    await expect(page.getByTestId('test-chat-assistant')).toHaveCount(2, {
      timeout: 60_000,
    });
    await expect(page.getByTestId('test-chat-input')).toHaveValue('');

    // Not one conversation was created in the inbox.
    expect(await conversationIds(page)).toEqual(before);

    await page.getByTestId('test-chat-reset').click();
    await expect(page.getByTestId('test-chat-customer')).toHaveCount(0);
    await expect(page.getByTestId('test-chat-starter-hello')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the reply shows what it looked up, a hand-over note and the collected details; errors are plain', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(
    browser,
    f.a.operators.admin.email,
  );
  let calls = 0;
  const bodies: Record<string, unknown>[] = [];
  try {
    await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption('en');
    await page.route('**/api/v1/assistant/test-chat', async (route) => {
      calls += 1;
      bodies.push(route.request().postDataJSON() as Record<string, unknown>);
      if (calls === 3)
        return route.fulfill({
          status: 429,
          json: {
            code: 'TEST_CHAT_RATE_LIMITED',
            i18nKey: 'errors.TEST_CHAT_RATE_LIMITED',
          },
        });
      return route.fulfill({ json: FAKE });
    });
    await page.goto('/settings/bot/test');
    await page.getByTestId('test-chat-input').fill('IELTS price?');
    await page.getByTestId('test-chat-send').click();

    const answer = page.getByTestId('test-chat-assistant');
    await expect(answer).toContainText('1 250 000 UZS per person');
    await expect(answer).toContainText('Would pass this chat to a person');
    await expect(answer).toContainText('Searched the catalog');
    await expect(answer).toContainText('Checked the price');
    // A tool that is not for display (booking) is not shown.
    await expect(answer).not.toContainText('book_slot');
    await expect(page.getByTestId('test-chat-details')).toContainText('IELTS');

    // The next message carries the dialogue, the details and the language.
    await page.getByTestId('test-chat-input').fill('And for two?');
    await page.getByTestId('test-chat-send').click();
    await expect(page.getByTestId('test-chat-assistant')).toHaveCount(2);
    expect(bodies[1]).toMatchObject({
      text: 'And for two?',
      language: 'en',
      script: 'Latn',
      slots: { subject: { value: 'IELTS' } },
      history: [
        { role: 'customer', text: 'IELTS price?' },
        { role: 'agent', text: FAKE.reply },
      ],
    });
    expect(typeof bodies[1]!.sessionId).toBe('string');
    expect(bodies[1]!.sessionId).toBe(bodies[0]!.sessionId);

    // Too many messages: a plain message, the chat stays.
    await page.getByTestId('test-chat-input').fill('again');
    await page.getByTestId('test-chat-send').click();
    await expect(page.getByTestId('test-chat-error')).toContainText(
      'Too many test messages',
    );
    await expect(page.getByTestId('test-chat-assistant')).toHaveCount(2);

    // Starting over makes a new chat (a new session id, no history).
    await page.getByTestId('test-chat-reset').click();
    await page.getByTestId('test-chat-input').fill('hi');
    await page.getByTestId('test-chat-send').click();
    await expect(page.getByTestId('test-chat-assistant')).toHaveCount(1);
    expect(bodies.at(-1)!.history).toEqual([]);
    expect(bodies.at(-1)!.sessionId).not.toBe(bodies[0]!.sessionId);
  } finally {
    await context.close();
  }
});

test('an operator cannot use the test chat: the page says so and the API refuses', async ({
  browser,
}) => {
  const f = fixtures();
  const { page, context } = await newSession(browser, f.a.operators.op1.email);
  try {
    await page.goto('/settings/bot/test');
    await expect(page.getByTestId('test-chat-input')).toHaveCount(0);
    await expect(page.getByTestId('bot-try')).toHaveCount(0);
    const refused = await postAsPage(page, '/api/v1/assistant/test-chat', {
      sessionId: crypto.randomUUID(),
      text: 'hi',
    });
    expect(refused.status).toBe(403);
    // The role check answered, not a missing token.
    expect(refused.body.code).toBe('FORBIDDEN');
  } finally {
    await context.close();
  }
});

test('the test chat has no accessibility violations and fits a phone in en, ru and uz-Latn', async ({
  browser,
}) => {
  const f = fixtures();
  for (const [language, width] of [
    ['en', 1280],
    ['ru', 320],
    ['uz-Latn', 320],
  ] as const) {
    const { page, context } = await newSession(
      browser,
      f.a.operators.admin.email,
      {
        viewport: { width, height: 700 },
      },
    );
    try {
      await page.getByLabel(/^(Language|Язык|Til)$/u).selectOption(language);
      await page.route('**/api/v1/assistant/test-chat', (route) =>
        route.fulfill({ json: FAKE }),
      );
      await page.goto('/settings/bot/test');
      await page.getByTestId('test-chat-input').fill('IELTS');
      await page.getByTestId('test-chat-send').click();
      await expect(page.getByTestId('test-chat-assistant')).toBeVisible();
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
