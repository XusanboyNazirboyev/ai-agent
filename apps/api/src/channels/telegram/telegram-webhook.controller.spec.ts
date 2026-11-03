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

  describe('group chats (ADR 036)', () => {
    type Mock = ReturnType<typeof vi.fn>;
    interface GroupSetup {
      webhook: Record<
        | 'assertWebhookSecret'
        | 'operatorChannel'
        | 'linkOperatorGroup'
        | 'accept',
        Mock
      >;
      bot: { sendMessage: Mock };
      controller: TelegramWebhookController;
    }
    function setup(linked: 'linked' | 'refused'): GroupSetup {
      const webhook = {
        assertWebhookSecret: vi.fn(),
        operatorChannel: vi.fn().mockResolvedValue({
          tenantId: 't1',
          operatorChatId: '-100999',
          channelAccountId: 'account-id',
        }),
        linkOperatorGroup: vi.fn().mockResolvedValue(linked),
        accept: vi.fn().mockResolvedValue('accepted'),
      };
      const bot = {
        sendMessage: vi.fn().mockResolvedValue({ messageId: '1' }),
      };
      const controller = new TelegramWebhookController(
        webhook as never,
        undefined,
        bot as never,
      );
      return { webhook, bot, controller };
    }
    const message = (
      chat: Record<string, unknown>,
      text: string,
    ): Record<string, unknown> => ({
      update_id: 10,
      message: { message_id: 3, date: 1, chat, from: { id: 5 }, text },
    });

    it('links a group with a valid /start code and confirms it there, never as a customer', async () => {
      const { webhook, bot, controller } = setup('linked');
      await expect(
        controller.receive(
          'account-id',
          'valid',
          message({ id: -100123, type: 'supergroup' }, '/start@tezda_bot code'),
        ),
      ).resolves.toEqual({ accepted: false, ignored: true });
      expect(webhook.linkOperatorGroup).toHaveBeenCalledWith(
        'account-id',
        expect.objectContaining({ chatId: '-100123', chatType: 'supergroup' }),
      );
      expect(bot.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: '-100123',
          channelAccountId: 'account-id',
        }),
      );
      expect(webhook.accept).not.toHaveBeenCalled();
    });

    it('ignores other group messages and refused codes without replying', async () => {
      const { webhook, bot, controller } = setup('refused');
      for (const type of ['group', 'supergroup', 'channel'])
        await expect(
          controller.receive(
            'account-id',
            'valid',
            message({ id: -100123, type }, 'hello bot'),
          ),
        ).resolves.toEqual({ accepted: false, ignored: true });
      expect(bot.sendMessage).not.toHaveBeenCalled();
      expect(webhook.accept).not.toHaveBeenCalled();
    });

    it('keeps private chats (and updates without a chat type) as customer messages', async () => {
      const { webhook, controller } = setup('refused');
      for (const chat of [{ id: 77, type: 'private' }, { id: 77 }])
        await expect(
          controller.receive('account-id', 'valid', message(chat, 'salom')),
        ).resolves.toMatchObject({ accepted: true });
      expect(webhook.accept).toHaveBeenCalledTimes(2);
      expect(webhook.linkOperatorGroup).not.toHaveBeenCalled();
    });

    it('still saves the link when the confirmation cannot be sent', async () => {
      const { bot, controller } = setup('linked');
      bot.sendMessage.mockRejectedValue(new Error('blocked'));
      await expect(
        controller.receive(
          'account-id',
          'valid',
          message({ id: -100123, type: 'group' }, '/start code'),
        ),
      ).resolves.toEqual({ accepted: false, ignored: true });
    });
  });
});
