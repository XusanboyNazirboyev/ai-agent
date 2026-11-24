import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { PlatformBotSender } from '../signup/platform-bot.sender.js';
import { PublicPlansController } from './public-plans.controller.js';
import { SalesInquiryController } from './sales-inquiry.controller.js';

/** Endpoints without a session (ADR 080). */
@Module({
  imports: [PersistenceModule],
  controllers: [PublicPlansController, SalesInquiryController],
  providers: [PlatformBotSender],
})
export class PublicModule {}
