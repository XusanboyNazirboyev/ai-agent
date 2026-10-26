import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AuthController } from './auth.controller.js';
import { ChannelsController } from './channels.controller.js';
import { ContactsController } from './contacts.controller.js';
import { EventsController } from './events.controller.js';
import { KnowledgeFaqController } from './knowledge-faq.controller.js';
import { InboxController } from './inbox.controller.js';
import { InboxEventBus } from './inbox-event-bus.js';
import { InboxEventsService } from './inbox-events.service.js';
import { InboxReadService } from './inbox-read.service.js';
import { SessionGuard } from './session.guard.js';
import { SessionService } from './session.service.js';

/** Web Operator Inbox backend (Phase 6A, ADR 020). */
@Module({
  imports: [PersistenceModule, KnowledgeModule],
  controllers: [
    AuthController,
    InboxController,
    EventsController,
    ChannelsController,
    KnowledgeFaqController,
    ContactsController,
  ],
  providers: [
    SessionService,
    SessionGuard,
    InboxReadService,
    InboxEventsService,
    InboxEventBus,
  ],
  exports: [SessionService, SessionGuard, InboxEventsService],
})
export class WebInboxModule {}
