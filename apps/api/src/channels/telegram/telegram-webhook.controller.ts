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
import { TelegramWebhookService } from './telegram-webhook.service.js';

@Controller('webhooks/telegram')
export class TelegramWebhookController {
  constructor(private readonly webhook: TelegramWebhookService) {}

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
    const result = await this.webhook.accept(channelAccountId, update);
    return {
      accepted: result === 'accepted',
      duplicate: result === 'duplicate',
    };
  }
}
