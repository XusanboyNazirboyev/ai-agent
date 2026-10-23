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
  normalizeTelegramUpdate,
} from './telegram-normalizer.js';
import { Optional } from '@nestjs/common';
import { OperatorUpdateHandler } from '../../handover/operator-update.handler.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';

@Controller('webhooks/telegram')
export class TelegramWebhookController {
  constructor(
    private readonly webhook: TelegramWebhookService,
    @Optional() private readonly operators?: OperatorUpdateHandler,
  ) {}

  @Post(':channelAccountId')
  @HttpCode(200)
  async receive(
    @Param('channelAccountId') channelAccountId: string,
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() body: unknown,
  ): Promise<{ accepted: boolean; duplicate?: boolean; ignored?: boolean }> {
    this.webhook.assertWebhookSecret(secret);
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
    const result = await this.webhook.accept(channelAccountId, update);
    return {
      accepted: result === 'accepted',
      duplicate: result === 'duplicate',
    };
  }
}
