import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import type { NormalizedTelegramUpdate } from './telegram-normalizer.js';
import {
  InvalidTelegramUpdateError,
  isPrivateChat,
  normalizeTelegramUpdate,
} from './telegram-normalizer.js';
import { Logger, Optional } from '@nestjs/common';
import { OperatorUpdateHandler } from '../../handover/operator-update.handler.js';
import { TelegramBotApi } from '../../handover/telegram-bot-api.js';

/** Posted in a group once it is linked as the operator group (ADR 036). */
export const GROUP_LINKED_TEXT =
  '✅ Operatorlar guruhi ulandi. Группа операторов подключена. Operator group connected.';
import { TelegramWebhookService } from './telegram-webhook.service.js';

@Controller('webhooks/telegram')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(
    private readonly webhook: TelegramWebhookService,
    @Optional() private readonly operators?: OperatorUpdateHandler,
    @Optional() private readonly bot?: TelegramBotApi,
  ) {}

  @Post(':channelAccountId')
  @HttpCode(200)
  async receive(
    @Param('channelAccountId') channelAccountId: string,
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() body: unknown,
  ): Promise<{ accepted: boolean; duplicate?: boolean; ignored?: boolean }> {
    await this.webhook.assertWebhookSecret(channelAccountId, secret);
    let update: NormalizedTelegramUpdate;
    try {
      update = normalizeTelegramUpdate(body);
    } catch (error) {
      if (error instanceof InvalidTelegramUpdateError) {
        throw new BadRequestException('Malformed Telegram update');
      }
      throw error;
    }
    if (update.kind === 'unsupported') {
      return { accepted: false, ignored: true };
    }
    // Operator-group traffic never enters customer intake.
    const channel = await this.webhook.operatorChannel(channelAccountId);
    if (channel.operatorChatId && update.chatId === channel.operatorChatId) {
      if (this.operators) {
        if (update.kind === 'callback') {
          await this.operators.handle(
            {
              tenantId: channel.tenantId,
              operatorChatId: channel.operatorChatId,
              channelAccountId: channel.channelAccountId,
            },
            {
              kind: 'callback',
              callbackId: update.callbackId,
              fromUserId: update.userId,
              chatId: update.chatId,
              messageId: update.messageId,
              data: update.data,
            },
          );
        } else {
          await this.operators.handle(
            {
              tenantId: channel.tenantId,
              operatorChatId: channel.operatorChatId,
              channelAccountId: channel.channelAccountId,
            },
            {
              kind: 'message',
              chatId: update.chatId,
              messageId: update.messageId,
              fromUserId: update.userId,
              text: update.text,
              ...(update.replyToText !== undefined
                ? { replyToText: update.replyToText }
                : {}),
            },
          );
        }
      }
      return { accepted: false, ignored: true };
    }
    if (update.kind === 'callback') return { accepted: false, ignored: true };
    // Groups are never customer conversations; the only thing a group can do
    // is link itself as the operator group with a one-click code.
    if (!isPrivateChat(update)) {
      const linked = await this.webhook.linkOperatorGroup(
        channelAccountId,
        update,
      );
      if (linked === 'linked')
        await this.confirmGroup(channelAccountId, update.chatId);
      return { accepted: false, ignored: true };
    }
    const result = await this.webhook.accept(channelAccountId, update);
    return {
      accepted: result === 'accepted',
      duplicate: result === 'duplicate',
    };
  }

  /** Best effort: the link is saved even when this message cannot be sent. */
  private async confirmGroup(
    channelAccountId: string,
    chatId: string,
  ): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.sendMessage({
        chatId,
        text: GROUP_LINKED_TEXT,
        channelAccountId,
      });
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'telegram.group_link_confirmation_failed',
          channelAccount: channelAccountId,
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }
  }
}
