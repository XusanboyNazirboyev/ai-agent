import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import type { EmbeddingProvider } from '../core/knowledge/embedding.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import {
  createEmbeddingProvider,
  EMBEDDING_PROVIDER,
} from './embedding.factory.js';
import { KnowledgeService } from './knowledge.service.js';

@Module({
  imports: [PersistenceModule],
  providers: [
    KnowledgeService,
    {
      provide: EMBEDDING_PROVIDER,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<AppEnvironment, true>,
      ): EmbeddingProvider | undefined =>
        createEmbeddingProvider({
          KNOWLEDGE_EMBEDDINGS:
            config.get('KNOWLEDGE_EMBEDDINGS', { infer: true }) ?? 'off',
          KNOWLEDGE_EMBEDDING_MODEL: config.get('KNOWLEDGE_EMBEDDING_MODEL', {
            infer: true,
          }),
          KNOWLEDGE_EMBEDDING_BASE_URL: config.get(
            'KNOWLEDGE_EMBEDDING_BASE_URL',
            { infer: true },
          ),
          NODE_ENV: config.get('NODE_ENV', { infer: true }),
        }),
    },
  ],
  exports: [KnowledgeService, EMBEDDING_PROVIDER],
})
export class KnowledgeModule {}
