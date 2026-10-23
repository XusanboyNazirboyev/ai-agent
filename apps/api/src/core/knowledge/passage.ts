/**
 * A retrieved passage of textual knowledge. Knowledge answers questions about
 * policies and information texts (D2); it is never a source of price, date,
 * seat or availability facts (D1). `source` and `updatedAt` are the internal
 * attribution kept in the turn record; for a regulated document the update
 * date is also rendered to the customer.
 */
export interface KnowledgePassage {
  readonly documentId: string;
  readonly text: string;
  readonly title: string;
  readonly source: string;
  readonly updatedAt: string;
  readonly regulated: boolean;
  readonly topic: string | null;
  /** Cosine similarity of the query and the passage, in [-1, 1]. */
  readonly score: number;
}

export type KnowledgeSearchResult =
  | { readonly ok: true; readonly passages: readonly KnowledgePassage[] }
  | {
      readonly ok: false;
      readonly code:
        | 'EMBEDDING_UNAVAILABLE'
        | 'KNOWLEDGE_DISABLED'
        | 'EMBEDDING_MODEL_MISMATCH';
    };

/** Per-turn retrieval port the agent tools use; metering lives behind it. */
export interface KnowledgeSearch {
  search(
    query: string,
    options?: { topic?: string },
  ): Promise<KnowledgeSearchResult>;
}
