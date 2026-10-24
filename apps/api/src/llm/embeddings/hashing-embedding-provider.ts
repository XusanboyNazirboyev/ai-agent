import type {
  EmbeddingProvider,
  EmbeddingResult,
} from '../../core/knowledge/embedding.js';

/**
 * TEST-ONLY embedder: hashes character trigrams of the normalized text into a
 * fixed-size vector. Texts that share words are close; it has no semantics
 * and no cross-lingual ability. It exists so retrieval plumbing, tenant
 * isolation and metering can be tested deterministically without a provider.
 * It must never be used to claim retrieval quality.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = 'hashing-test';
  readonly model = 'hashing-test-embedder';

  constructor(private readonly dims = 256) {}

  embed(texts: readonly string[]): Promise<EmbeddingResult> {
    return Promise.resolve({
      vectors: texts.map((text) => this.vector(text)),
      inputTokens: texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
    });
  }

  private vector(text: string): number[] {
    const normalized = ` ${text.toLowerCase().replace(/\s+/gu, ' ').trim()} `;
    const out = new Array<number>(this.dims).fill(0);
    for (let i = 0; i + 3 <= normalized.length; i++) {
      let hash = 2166136261;
      for (let j = 0; j < 3; j++)
        hash = Math.imul(hash ^ normalized.charCodeAt(i + j), 16777619) >>> 0;
      out[hash % this.dims] += 1;
    }
    const norm = Math.sqrt(out.reduce((sum, v) => sum + v * v, 0)) || 1;
    return out.map((v) => v / norm);
  }
}
