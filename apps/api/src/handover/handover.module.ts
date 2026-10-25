import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import {
  HandoverNotificationService,
  OPERATOR_NOTIFIER,
} from './handover-notification.service.js';
import { HandoverSlaService } from './handover-sla.service.js';
import { HandoverService } from './handover.service.js';
import { OperatorCommandsController } from './operator-commands.controller.js';
import { OperatorRequestGuard } from './operator-request-guard.js';
import { WebInboxModule } from '../webinbox/webinbox.module.js';
import { OperatorTokenGuard } from './operator-auth.js';
import { OperatorUpdateHandler } from './operator-update.handler.js';
import { TelegramBotApi } from './telegram-bot-api.js';
import { TelegramGroupNotifier } from './telegram-group-notifier.js';

@Module({
  imports: [PersistenceModule, WebInboxModule],
  controllers: [OperatorCommandsController],
  providers: [
    OperatorTokenGuard,
    OperatorRequestGuard,
    HandoverService,
    HandoverSlaService,
    HandoverNotificationService,
    OperatorUpdateHandler,
    TelegramBotApi,
    TelegramGroupNotifier,
    { provide: OPERATOR_NOTIFIER, useExisting: TelegramGroupNotifier },
  ],
  exports: [
    HandoverService,
    HandoverSlaService,
    HandoverNotificationService,
    OperatorUpdateHandler,
  ],
})
export class HandoverModule {}
