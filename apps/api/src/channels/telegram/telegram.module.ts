import { Module } from '@nestjs/common';
import { AgentModule } from '../../agent/agent.module.js';
import { PersistenceModule } from '../../persistence/persistence.module.js';
import { TelegramAgentPipeline } from './telegram-agent-pipeline.js';
import { TelegramProcessor } from './telegram-processor.js';
import { TelegramQueueRuntime } from './telegram-queue.runtime.js';
import { TelegramSender } from './telegram-sender.js';
import { TelegramWebhookController } from './telegram-webhook.controller.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';

@Module({
  imports: [PersistenceModule, AgentModule],
  controllers: [TelegramWebhookController],
  providers: [
    TelegramWebhookService,
    TelegramSender,
    TelegramAgentPipeline,
    TelegramProcessor,
    TelegramQueueRuntime,
  ],
})
export class TelegramModule {}
