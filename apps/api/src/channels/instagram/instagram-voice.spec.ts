import { describe, expect, it } from 'vitest';
import { normalizeInstagramWebhook } from './instagram-normalizer.js';

/**
 * Inbound audio on the Instagram messages webhook. The shape is the one the
 * official "Webhook Notification Examples" page gives (read 2026-11-10):
 * `message.attachments[] { type, payload { url } }`, `audio` among the
 * supported types, `is_unsupported: true` for unsupported media. That page
 * does not say whether an in-app voice message arrives as `audio`, how long
 * the URL lives, or its format, so those are not assumed here.
 */
const now = new Date('2026-11-10T10:00:00Z');

function webhook(message: Record<string, unknown>): unknown {
  return {
    object: 'instagram',
    entry: [
      {
        id: '17841400000000000',
        time: 1,
        messaging: [
          {
            sender: { id: '17841411111111111' },
            recipient: { id: '17841400000000000' },
            timestamp: 1,
            message: { mid: 'mid-voice-1', ...message },
          },
        ],
      },
    ],
  };
}

const events = (message: Record<string, unknown>): unknown => {
  const result = normalizeInstagramWebhook(webhook(message), now);
  if (!result.ok) throw new Error('invalid');
  return result.events;
};

describe('Instagram audio attachments', () => {
  it('turns an audio attachment into a voice event with its URL', () => {
    expect(
      events({
        attachments: [
          {
            type: 'audio',
            payload: { url: 'https://cdn.example.test/a.m4a?sig=1' },
          },
        ],
      }),
    ).toEqual([
      {
        kind: 'voice',
        messageId: 'mid-voice-1',
        accountId: '17841400000000000',
        customerId: '17841411111111111',
        url: 'https://cdn.example.test/a.m4a?sig=1',
        receivedAt: now,
      },
    ]);
  });

  it('uses the first audio attachment and ignores other attachment types', () => {
    expect(
      events({
        attachments: [
          { type: 'image', payload: { url: 'https://cdn.example.test/i.jpg' } },
          { type: 'audio', payload: { url: 'https://cdn.example.test/a1' } },
          { type: 'audio', payload: { url: 'https://cdn.example.test/a2' } },
        ],
      }),
    ).toMatchObject([{ kind: 'voice', url: 'https://cdn.example.test/a1' }]);
  });

  it('keeps ordinary text first: text with an audio attachment stays a text message', () => {
    expect(
      events({
        text: 'Salom',
        attachments: [
          { type: 'audio', payload: { url: 'https://cdn.example.test/a' } },
        ],
      }),
    ).toMatchObject([{ kind: 'text', text: 'Salom' }]);
  });

  it('ignores a malformed, missing, oversized or non-string URL as no_text', () => {
    for (const attachments of [
      [{ type: 'audio' }],
      [{ type: 'audio', payload: {} }],
      [{ type: 'audio', payload: { url: 42 } }],
      [
        {
          type: 'audio',
          payload: { url: `https://x.test/${'a'.repeat(2_100)}` },
        },
      ],
      [{ type: 'image', payload: { url: 'https://cdn.example.test/i.jpg' } }],
    ]) {
      expect(events({ attachments })).toEqual([
        { kind: 'ignored', reason: 'no_text' },
      ]);
    }
  });

  it('does not answer our own echo of a voice message', () => {
    expect(
      events({
        is_echo: true,
        attachments: [
          { type: 'audio', payload: { url: 'https://cdn.example.test/a' } },
        ],
      }),
    ).toEqual([{ kind: 'ignored', reason: 'echo' }]);
  });
});
