import { describe, expect, it } from 'vitest';
import { buildSetWebhookPayload } from './dev-guards.js';

const env = {
  TELEGRAM_CHANNEL_ACCOUNT_ID: 'acc-1',
  TELEGRAM_WEBHOOK_SECRET: 's_3cret',
};

describe('buildSetWebhookPayload', () => {
  it('keeps pending updates by default', () => {
    expect(buildSetWebhookPayload(env, 'https://x.example/')).toMatchObject({
      url: 'https://x.example/webhooks/telegram/acc-1',
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
  });
  it.each([undefined, '', 'false', 'TRUE', '1', 'yes'])(
    'does not drop pending updates for %j',
    (value) => {
      expect(
        buildSetWebhookPayload(
          { ...env, TELEGRAM_DROP_PENDING_UPDATES: value },
          'https://x.example',
        ).drop_pending_updates,
      ).toBe(false);
    },
  );
  it('drops only on an explicit "true"', () => {
    expect(
      buildSetWebhookPayload(
        { ...env, TELEGRAM_DROP_PENDING_UPDATES: 'true' },
        'https://x.example',
      ).drop_pending_updates,
    ).toBe(true);
  });
});
