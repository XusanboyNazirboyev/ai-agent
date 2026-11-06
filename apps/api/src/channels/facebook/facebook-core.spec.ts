import { describe, expect, it } from 'vitest';
import {
  answerMetaHandshake,
  signMetaBody,
  verifyMetaSignature,
} from '../meta/meta-webhook-auth.js';
import { normalizeFacebookWebhook } from './facebook-normalizer.js';
import {
  FACEBOOK_WINDOW_MS,
  evaluateFacebookWindow,
  type FacebookWindowDecision,
} from './facebook-messaging-window.js';
import { buildFacebookTextRequests } from './facebook-send-body.js';

const secret = 'test-app-secret-not-real';
const now = new Date('2026-11-06T10:00:00Z');

const webhook = (
  message: Record<string, unknown> | undefined,
  sender = 'PSID1',
): unknown => ({
  object: 'page',
  entry: [
    {
      id: 'PAGE1',
      time: 1,
      messaging: [
        {
          sender: { id: sender },
          recipient: { id: 'PAGE1' },
          timestamp: 1,
          ...(message ? { message } : {}),
        },
      ],
    },
  ],
});

describe('Meta webhook signature on Messenger bodies', () => {
  it('verifies the raw bytes, including an escaped-unicode body', () => {
    // Meta signs the escaped form, so that is also what arrives on the wire.
    const raw =
      '{"object":"page","entry":[{"id":"1","messaging":[{"message":{"text":"\\u0421\\u0430\\u043b\\u043e\\u043c"}}]}]}';
    const header = signMetaBody(raw, secret);
    expect(
      verifyMetaSignature({ rawBody: raw, header, appSecret: secret }),
    ).toBe(true);
  });

  it('rejects the decoded form of an escaped body (the documented pitfall)', () => {
    const escaped = '{"text":"\\u0421\\u0430\\u043b\\u043e\\u043c"}';
    const decoded = JSON.stringify(JSON.parse(escaped));
    expect(decoded).not.toBe(escaped);
    const header = signMetaBody(escaped, secret);
    expect(
      verifyMetaSignature({ rawBody: decoded, header, appSecret: secret }),
    ).toBe(false);
  });

  it('answers the handshake only for the right token', () => {
    const base = {
      mode: 'subscribe',
      verifyToken: 't',
      challenge: '42',
      expectedToken: 't',
    };
    expect(answerMetaHandshake(base)).toBe('42');
    expect(answerMetaHandshake({ ...base, verifyToken: 'x' })).toBeUndefined();
  });
});

describe('Facebook normalizer', () => {
  it('maps a customer text with the Page, the PSID and our receive time', () => {
    expect(
      normalizeFacebookWebhook(
        webhook({ mid: 'mid.1', text: 'Salom, narxi qancha?' }),
        now,
      ),
    ).toEqual({
      ok: true,
      events: [
        {
          kind: 'text',
          messageId: 'mid.1',
          accountId: 'PAGE1',
          customerId: 'PSID1',
          text: 'Salom, narxi qancha?',
          receivedAt: now,
        },
      ],
    });
  });

  it.each([
    ['echo', { mid: 'm', text: 'x', is_echo: true }, 'PSID1'],
    ['echo', { mid: 'm', text: 'x' }, 'PAGE1'],
    ['deleted', { mid: 'm', is_deleted: true }, 'PSID1'],
    ['no_text', { mid: 'm', attachments: [{ type: 'image' }] }, 'PSID1'],
    ['no_text', { mid: 'm', text: '  ' }, 'PSID1'],
  ])(
    'ignores %s so the bot never answers itself or empty input',
    (reason, m, sender) => {
      expect(normalizeFacebookWebhook(webhook(m, sender), now)).toEqual({
        ok: true,
        events: [{ kind: 'ignored', reason }],
      });
    },
  );

  it('ignores events without a message (postbacks, receipts)', () => {
    expect(normalizeFacebookWebhook(webhook(undefined), now)).toEqual({
      ok: true,
      events: [{ kind: 'ignored', reason: 'not_a_message' }],
    });
  });

  it('never reads standby, and rejects other objects and bad bodies', () => {
    const standby = {
      object: 'page',
      entry: [
        {
          id: 'PAGE1',
          standby: [
            {
              sender: { id: 'PSID1' },
              recipient: { id: 'PAGE1' },
              message: { mid: 'm', text: 'hi' },
            },
          ],
        },
      ],
    };
    expect(normalizeFacebookWebhook(standby, now)).toEqual({
      ok: true,
      events: [],
    });
    expect(
      normalizeFacebookWebhook({ object: 'instagram', entry: [] }, now),
    ).toEqual({ ok: false, reason: 'wrong_object' });
    expect(normalizeFacebookWebhook({ nope: 1 }, now)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('Facebook 24-hour window', () => {
  const ago = (ms: number): Date => new Date(now.getTime() - ms);
  it('allows a reply inside 24h, refuses after and without a customer message', () => {
    const at = (ms: number): FacebookWindowDecision =>
      evaluateFacebookWindow({ lastCustomerMessageAt: ago(ms), now });
    expect(at(1000)).toEqual({ allowed: true });
    expect(at(FACEBOOK_WINDOW_MS)).toEqual({ allowed: true });
    expect(at(FACEBOOK_WINDOW_MS + 1)).toEqual({
      allowed: false,
      reason: 'window_closed',
    });
    expect(
      evaluateFacebookWindow({ lastCustomerMessageAt: undefined, now }),
    ).toEqual({ allowed: false, reason: 'no_customer_message' });
  });
});

describe('Facebook send body', () => {
  it('builds RESPONSE requests, split by bytes for Cyrillic', () => {
    const one = buildFacebookTextRequests('12345', 'Salom');
    expect(one).toEqual([
      {
        recipient: { id: '12345' },
        messaging_type: 'RESPONSE',
        message: { text: 'Salom' },
      },
    ]);
    const long = buildFacebookTextRequests('12345', 'Салом курс '.repeat(200));
    expect(long.length).toBeGreaterThan(1);
    for (const r of long)
      expect(Buffer.byteLength(r.message.text)).toBeLessThanOrEqual(1_000);
  });

  it('refuses a malformed recipient before any network call', () => {
    expect(() => buildFacebookTextRequests('12/../x', 'hi')).toThrow(
      RangeError,
    );
    expect(() => buildFacebookTextRequests('', 'hi')).toThrow(RangeError);
  });
});
