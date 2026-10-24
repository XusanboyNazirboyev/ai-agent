import type { LlmError } from '../llm/llm-provider.js';

/**
 * Embedding port for knowledge retrieval. Implementations must throw
 * `LlmError` (typed codes) so metering can tell an unbilled failure from one
 * that may have been billed. The vector length is whatever the model returns;
 * the knowledge store records model and length and never compares vectors of
 * different models.
 */
export interface EmbeddingResult {
  readonly vectors: readonly (readonly number[])[];
  /** Input tokens when the provider reports them; absent = not reported. */
  readonly inputTokens?: number;
}

export interface EmbeddingProvider {
  readonly providerId: string;
  /** Model id; used for pricing and recorded with every stored vector. */
  readonly model: string;
  embed(
    texts: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<EmbeddingResult>;
}

export type EmbeddingFailure = LlmError;

export function assertUniformVectors(
  vectors: readonly (readonly number[])[],
  expected: number,
): number {
  if (vectors.length !== expected)
    throw new RangeError(`Expected ${expected} vectors, got ${vectors.length}`);
  const dims = vectors[0]?.length ?? 0;
  if (dims === 0) throw new RangeError('Empty embedding');
  for (const vector of vectors) {
    if (vector.length !== dims) throw new RangeError('Mixed embedding sizes');
    for (const value of vector)
      if (!Number.isFinite(value)) throw new RangeError('Non-finite embedding');
  }
  return dims;
}
