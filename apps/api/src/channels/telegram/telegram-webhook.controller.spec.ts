import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { TelegramWebhookController } from './telegram-webhook.controller.js';

describe('TelegramWebhookController', () => {
  it('rejects an invalid secret before durable acceptance', async () => {
    const webhook = {
      assertWebhookSecret: vi.fn(() => {
        throw new UnauthorizedException();
      }),
      accept: vi.fn(),
    };
    const controller = new TelegramWebhookController(webhook as never);

    await expect(
      controller.receive('account-id', 'wrong', { update_id: 1 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(webhook.accept).not.toHaveBeenCalled();
  });

  it('rejects malformed updates and acknowledges unsupported message types without storage', async () => {
    const webhook = {
      assertWebhookSecret: vi.fn(),
      accept: vi.fn(),
    };
    const controller = new TelegramWebhookController(webhook as never);

    await expect(
      controller.receive('account-id', 'valid', { update_id: 'bad' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.receive('account-id', 'valid', {
        update_id: 2,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 7 },
          from: { id: 7 },
          photo: [],
        },
      }),
    ).resolves.toEqual({ accepted: false, ignored: true });
    expect(webhook.accept).not.toHaveBeenCalled();
  });
});
