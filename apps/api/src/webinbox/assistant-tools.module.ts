import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SuggestReplyController } from './suggest-reply.controller.js';
import { TestChatController } from './test-chat.controller.js';
import { WebInboxModule } from './webinbox.module.js';

/**
 * The endpoints that run the assistant for people, not for customers: the
 * test chat (ADR 065) and the reply suggestion (ADR 066). A module of its own,
 * and nothing imports it but the application: the agent module reaches the web
 * inbox module through several others, so these controllers cannot live in the
 * web inbox module without an import cycle.
 */
@Module({
  imports: [PersistenceModule, AgentModule, WebInboxModule],
  controllers: [TestChatController, SuggestReplyController],
})
export class AssistantToolsModule {}
