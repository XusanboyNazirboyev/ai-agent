import { LlmError } from '../../core/llm/llm-provider.js';
import {
  assertUniformVectors,
  type EmbeddingProvider,
  type EmbeddingResult,
} from '../../core/knowledge/embedding.js';

/**
 * Embeddings through the OpenAI-compatible `POST {baseUrl}/embeddings` shape
 * (`{ model, input }` -> `data[].embedding`, `usage.prompt_tokens`). Gemini
 * documents this endpoint at
 * https://ai.google.dev/gemini-api/docs/openai (model `gemini-embedding-001`
 * for text; read 2026-10-24; no `dimensions` parameter is documented there,
 * so none is sent). Errors map to the same typed codes as the chat adapter.
 */
export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly providerId: string;

  constructor(
    private readonly options: {
      readonly providerId: string;
      readonly baseUrl: string;
      readonly model: string;
      readonly apiKey?: string;
      readonly requestTimeoutMs?: number;
      readonly fetch?: typeof fetch;
    },
  ) {
    this.providerId = options.providerId;
  }

  get model(): string {
    return this.options.model;
  }

  async embed(
    texts: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<EmbeddingResult> {
    const request = this.options.fetch ?? fetch;
    const timeout = AbortSignal.timeout(
      this.options.requestTimeoutMs ?? 30_000,
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    let response: Response;
    try {
      response = await request(
        `${this.options.baseUrl.replace(/\/$/u, '')}/embeddings`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.options.apiKey
              ? { authorization: `Bearer ${this.options.apiKey}` }
              : {}),
          },
          body: JSON.stringify({ model: this.options.model, input: texts }),
          signal,
        },
      );
    } catch (error) {
      if (options.signal?.aborted)
        throw new LlmError('LLM_CANCELLED', 'Embedding cancelled', false);
      if ((error as Error).name === 'TimeoutError' || timeout.aborted)
        throw new LlmError('LLM_TIMEOUT', 'Embedding request timed out', true);
      throw new LlmError(
        'LLM_UNAVAILABLE',
        'Embedding provider unreachable',
        true,
      );
    }
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      if (response.status === 429)
        throw new LlmError(
          'LLM_RATE_LIMITED',
          'Embedding rate limited',
          true,
          Number.isFinite(retryAfter) ? retryAfter * 1_000 : undefined,
        );
      if (response.status === 401 || response.status === 403)
        throw new LlmError(
          'LLM_AUTHENTICATION',
          'Embedding authentication failed',
          false,
        );
      if (response.status === 404)
        throw new LlmError(
          'LLM_UNSUPPORTED_FEATURE',
          'Embedding model or endpoint not available',
          false,
        );
      if (response.status >= 500)
        throw new LlmError(
          'LLM_UNAVAILABLE',
          `Embedding provider error ${response.status}`,
          true,
        );
      throw new LlmError(
        'LLM_INVALID_REQUEST',
        `Embedding request rejected (${response.status})`,
        false,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new LlmError(
        'LLM_UNAVAILABLE',
        'Embedding response was not JSON',
        true,
      );
    }
    const data = (
      body as { data?: Array<{ embedding?: unknown; index?: number }> }
    )?.data;
    if (!Array.isArray(data))
      throw new LlmError(
        'LLM_UNAVAILABLE',
        'Embedding response had no data',
        true,
      );
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = ordered.map((item) => item.embedding);
    if (
      !vectors.every(
        (v): v is number[] =>
          Array.isArray(v) && v.every((x) => typeof x === 'number'),
      )
    )
      throw new LlmError(
        'LLM_UNAVAILABLE',
        'Embedding response was malformed',
        true,
      );
    try {
      assertUniformVectors(vectors, texts.length);
    } catch {
      throw new LlmError(
        'LLM_UNAVAILABLE',
        'Embedding response had the wrong shape',
        true,
      );
    }
    const tokens = (body as { usage?: { prompt_tokens?: unknown } }).usage
      ?.prompt_tokens;
    return {
      vectors,
      ...(typeof tokens === 'number' && Number.isFinite(tokens)
        ? { inputTokens: tokens }
        : {}),
    };
  }
}
