import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { TestChatController } from './test-chat.controller.js';
import { WebInboxModule } from './webinbox.module.js';

/**
 * The assistant test chat (ADR 065). A module of its own, and nothing imports
 * it but the application: the agent module reaches the web inbox module
 * through several others, so the controller cannot live in the web inbox
 * module without an import cycle.
 */
@Module({
  imports: [PersistenceModule, AgentModule, WebInboxModule],
  controllers: [TestChatController],
})
export class TestChatModule {}
