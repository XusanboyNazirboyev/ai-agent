import { Module } from '@nestjs/common';
import { TelegramModule } from '../channels/telegram/telegram.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { WebInboxModule } from '../webinbox/webinbox.module.js';
import { PlatformBotSender } from './platform-bot.sender.js';
import {
  PlatformTelegramWebhookController,
  SignupController,
} from './signup.controller.js';
import { SignupService } from './signup.service.js';

/** Self-serve signup confirmed through the platform Telegram bot (ADR 080). */
@Module({
  imports: [PersistenceModule, WebInboxModule, TelegramModule],
  controllers: [SignupController, PlatformTelegramWebhookController],
  providers: [SignupService, PlatformBotSender],
})
export class SignupModule {}
