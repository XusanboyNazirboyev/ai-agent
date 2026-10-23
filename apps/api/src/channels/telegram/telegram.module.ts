import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../persistence/persistence.module.js';
import { TelegramProcessor } from './telegram-processor.js';
import { TelegramQueueRuntime } from './telegram-queue.runtime.js';
import { TelegramSender } from './telegram-sender.js';
import { TelegramWebhookController } from './telegram-webhook.controller.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';

@Module({
  imports: [PersistenceModule],
  controllers: [TelegramWebhookController],
  providers: [
    TelegramWebhookService,
    TelegramSender,
    TelegramProcessor,
    TelegramQueueRuntime,
  ],
})
export class TelegramModule {}
