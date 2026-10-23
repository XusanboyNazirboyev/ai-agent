import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import {
  HandoverNotificationService,
  OPERATOR_NOTIFIER,
} from './handover-notification.service.js';
import { HandoverRuntime } from './handover-runtime.js';
import { HandoverSlaService } from './handover-sla.service.js';
import { HandoverService } from './handover.service.js';
import { OperatorUpdateHandler } from './operator-update.handler.js';
import { TelegramBotApi } from './telegram-bot-api.js';
import { TelegramGroupNotifier } from './telegram-group-notifier.js';

@Module({
  imports: [PersistenceModule],
  providers: [
    HandoverService,
    HandoverSlaService,
    HandoverNotificationService,
    HandoverRuntime,
    OperatorUpdateHandler,
    TelegramBotApi,
    TelegramGroupNotifier,
    { provide: OPERATOR_NOTIFIER, useExisting: TelegramGroupNotifier },
  ],
  exports: [
    HandoverService,
    HandoverSlaService,
    HandoverNotificationService,
    HandoverRuntime,
    OperatorUpdateHandler,
  ],
})
export class HandoverModule {}
