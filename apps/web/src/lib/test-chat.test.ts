import { describe, expect, it } from 'vitest';
import {
  newChat,
  requestBody,
  TEST_CHAT_HISTORY_LIMIT,
  toolLabelKeys,
  withReply,
  type TestChatReply,
} from './test-chat';

const reply = (over: Partial<TestChatReply> = {}): TestChatReply => ({
  reply: 'Hello!',
  outcome: 'ANSWERED',
  handover: null,
  language: 'uz',
  script: 'Latn',
  slots: { subject: { value: 'IELTS', source: 'customer' } },
  toolsUsed: ['search_catalog', 'get_quote'],
  askedSlot: null,
  ...over,
});

describe('test chat state', () => {
  it('carries the dialogue, the collected details and the language to the next message', () => {
    const first = withReply(newChat('s1'), '  Salom ', reply());
    expect(first.messages.map((m) => [m.role, m.text])).toEqual([
      ['customer', 'Salom'],
      ['agent', 'Hello!'],
    ]);
    const body = requestBody(first, 'IELTS kerak');
    expect(body).toMatchObject({
      sessionId: 's1',
      text: 'IELTS kerak',
      language: 'uz',
      script: 'Latn',
      slots: { subject: { value: 'IELTS' } },
    });
    expect(body.history).toEqual([
      { role: 'customer', text: 'Salom' },
      { role: 'agent', text: 'Hello!' },
    ]);
  });

  it('sends only the newest turns and never an oversized text', () => {
    let state = newChat('s2');
    for (let i = 0; i < 40; i += 1)
      state = withReply(state, `q${i}`, reply({ reply: `a${i}` }));
    const body = requestBody(state, 'x'.repeat(5_000));
    expect((body.history as unknown[]).length).toBe(TEST_CHAT_HISTORY_LIMIT);
    expect((body.history as { text: string }[]).at(-1)!.text).toBe('a39');
    expect((body.text as string).length).toBe(1_000);
  });

  it('keeps the old language when the reply names none', () => {
    const state = withReply(
      withReply(newChat('s3'), 'a', reply()),
      'b',
      reply({ language: null, script: null }),
    );
    expect([state.language, state.script]).toEqual(['uz', 'Latn']);
  });

  it('records whether the assistant would hand over', () => {
    const state = withReply(
      newChat('s4'),
      'help',
      reply({ handover: 'NO_DATA' }),
    );
    expect(state.messages[1]!.handover).toBe('NO_DATA');
  });
});

describe('toolLabelKeys', () => {
  it('words the lookups once each and hides tools that are not for display', () => {
    expect(
      toolLabelKeys([
        'search_catalog',
        'get_quote',
        'search_catalog',
        'book_slot',
        'nope',
      ]),
    ).toEqual(['testChat.tool.search', 'testChat.tool.price']);
  });
});
