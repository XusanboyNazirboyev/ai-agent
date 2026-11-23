import { Module } from '@nestjs/common';
import { AccessModule } from '../../access/access.module.js';
import { AgentModule } from '../../agent/agent.module.js';
import { HandoverModule } from '../../handover/handover.module.js';
import { LeadsModule } from '../../leads/leads.module.js';
import { ActionsModule } from '../../actions/actions.module.js';
import { InstagramModule } from '../instagram/instagram.module.js';
import { PersistenceModule } from '../../persistence/persistence.module.js';
import { TelegramCredentialsModule } from './telegram-credentials.js';
import { TelegramAgentPipeline } from './telegram-agent-pipeline.js';
import { VoiceTranscriptionService } from '../voice/voice-transcription.service.js';
import { VoiceReplyService } from '../voice/voice-reply.service.js';
import { VoiceMediaController, VoiceMediaStore } from '../voice/voice-media.js';
import { InboundProcessor } from '../inbound/inbound-processor.js';
import { TelegramQueueRuntime } from './telegram-queue.runtime.js';
import { TelegramSender } from './telegram-sender.js';
import { TelegramWebhookController } from './telegram-webhook.controller.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';

@Module({
  imports: [
    PersistenceModule,
    AccessModule,
    AgentModule,
    HandoverModule,
    LeadsModule,
    ActionsModule,
    TelegramCredentialsModule,
    InstagramModule,
  ],
  controllers: [TelegramWebhookController, VoiceMediaController],
  providers: [
    TelegramWebhookService,
    TelegramSender,
    TelegramAgentPipeline,
    InboundProcessor,
    VoiceReplyService,
    VoiceMediaStore,
    TelegramQueueRuntime,
    VoiceTranscriptionService,
  ],
})
export class TelegramModule {}
