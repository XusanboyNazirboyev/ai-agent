import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AuthController } from './auth.controller.js';
import { EventsController } from './events.controller.js';
import { InboxController } from './inbox.controller.js';
import { InboxEventsService } from './inbox-events.service.js';
import { InboxReadService } from './inbox-read.service.js';
import { SessionGuard } from './session.guard.js';
import { SessionService } from './session.service.js';

/** Web Operator Inbox backend (Phase 6A, ADR 020). */
@Module({
  imports: [PersistenceModule],
  controllers: [AuthController, InboxController, EventsController],
  providers: [
    SessionService,
    SessionGuard,
    InboxReadService,
    InboxEventsService,
  ],
  exports: [SessionService, SessionGuard, InboxEventsService],
})
export class WebInboxModule {}
