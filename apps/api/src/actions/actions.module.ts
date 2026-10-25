import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module.js';
import { HandoverModule } from '../handover/handover.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { WebInboxModule } from '../webinbox/webinbox.module.js';
import { ActionService } from './action.service.js';
import { ActionsInboxController } from './actions-inbox.controller.js';

/** Customer-confirmed business actions (ADR 024). */
@Module({
  imports: [
    PersistenceModule,
    ConnectorsModule,
    HandoverModule,
    WebInboxModule,
  ],
  controllers: [ActionsInboxController],
  providers: [ActionService],
  exports: [ActionService],
})
export class ActionsModule {}
