import { BudgetExhaustedError } from '../core/llm/budget.js';
import type { MeteredLlm } from '../core/llm/metered-llm.js';
import type { EmbeddingProvider } from '../core/knowledge/embedding.js';
import type {
  KnowledgeSearch,
  KnowledgeSearchResult,
} from '../core/knowledge/passage.js';
import type { KnowledgeService } from './knowledge.service.js';

/**
 * Per-turn retrieval: the query is embedded through `MeteredLlm.embed`
 * (reservation, ledger, unknown-usage rules) and searched inside the turn's
 * tenant only. A budget stop propagates (the turn hands over for budget);
 * any other embedding failure is reported as unavailable, never as "no
 * knowledge", so a provider outage cannot read as an answer.
 */
export class KnowledgeRetriever implements KnowledgeSearch {
  constructor(
    private readonly store: KnowledgeService,
    private readonly embedder: EmbeddingProvider,
    private readonly llm: MeteredLlm,
    private readonly tenantId: string,
    private readonly limit = 4,
  ) {}

  async search(
    query: string,
    options: { topic?: string } = {},
  ): Promise<KnowledgeSearchResult> {
    try {
      const [vector] = await this.llm.embed(this.embedder, [query]);
      const passages = await this.store.search(this.tenantId, vector, {
        model: this.embedder.model,
        limit: this.limit,
        ...(options.topic ? { topic: options.topic } : {}),
      });
      return { ok: true, passages };
    } catch (error: unknown) {
      if (error instanceof BudgetExhaustedError) throw error;
      return { ok: false, code: 'EMBEDDING_UNAVAILABLE' };
    }
  }
}
