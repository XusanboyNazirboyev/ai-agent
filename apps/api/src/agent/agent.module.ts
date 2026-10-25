import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { ActionsModule } from '../actions/actions.module.js';
import { ConnectorsModule } from '../connectors/connectors.module.js';
import type { LlmProvider } from '../core/llm/llm-provider.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import {
  AgentConversationService,
  LLM_PROVIDER,
} from './agent-conversation.service.js';
import { AgentModeStartupCheck } from './agent-mode.startup.js';
import { createLlmProvider, llmEnvironment } from './llm.factory.js';
import { LlmBudgetLedger } from './llm-budget-ledger.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { LlmUsageStore } from './llm-usage.store.js';

@Module({
  imports: [
    PersistenceModule,
    ConnectorsModule,
    KnowledgeModule,
    ActionsModule,
  ],
  providers: [
    LlmUsageStore,
    LlmBudgetLedger,
    AgentConversationService,
    AgentModeStartupCheck,
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnvironment, true>): LlmProvider =>
        createLlmProvider(llmEnvironment(config)),
    },
  ],
  exports: [AgentConversationService],
})
export class AgentModule {}
