import type { EmbeddingProvider } from '../core/knowledge/embedding.js';
import { HashingEmbeddingProvider } from '../llm/embeddings/hashing-embedding-provider.js';
import { OpenAiCompatibleEmbeddingProvider } from '../llm/embeddings/openai-compatible-embedding-provider.js';
import { presetFor } from '../llm/provider-presets.js';

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

export interface EmbeddingEnvironment {
  readonly KNOWLEDGE_EMBEDDINGS:
    'off' | 'gemini' | 'openai-compatible' | 'hashing';
  readonly KNOWLEDGE_EMBEDDING_MODEL?: string;
  readonly KNOWLEDGE_EMBEDDING_BASE_URL?: string;
  readonly NODE_ENV: string;
}

/**
 * Builds the embedder named by configuration, or undefined (knowledge off).
 * `gemini` uses the preset's OpenAI-compatible base URL and key variable;
 * `openai-compatible` takes a base URL and the key from
 * KNOWLEDGE_EMBEDDING_API_KEY; `hashing` is the test embedder and is refused
 * in production. A model name is always required for the network providers:
 * none is assumed.
 */
export function createEmbeddingProvider(
  env: EmbeddingEnvironment,
  secrets: Readonly<Record<string, string | undefined>> = process.env,
): EmbeddingProvider | undefined {
  switch (env.KNOWLEDGE_EMBEDDINGS) {
    case 'off':
      return undefined;
    case 'hashing':
      if (env.NODE_ENV === 'production')
        throw new Error(
          'KNOWLEDGE_EMBEDDINGS=hashing is for tests and is refused in production',
        );
      return new HashingEmbeddingProvider();
    case 'gemini': {
      const preset = presetFor('gemini');
      const key = secrets[preset.apiKeyEnvVar];
      if (!key) throw new Error(`${preset.apiKeyEnvVar} is not set`);
      if (!env.KNOWLEDGE_EMBEDDING_MODEL)
        throw new Error('KNOWLEDGE_EMBEDDING_MODEL is required');
      return new OpenAiCompatibleEmbeddingProvider({
        providerId: 'gemini',
        baseUrl: preset.baseUrl,
        model: env.KNOWLEDGE_EMBEDDING_MODEL,
        apiKey: key,
      });
    }
    case 'openai-compatible': {
      if (!env.KNOWLEDGE_EMBEDDING_BASE_URL || !env.KNOWLEDGE_EMBEDDING_MODEL)
        throw new Error(
          'KNOWLEDGE_EMBEDDING_BASE_URL and KNOWLEDGE_EMBEDDING_MODEL are required',
        );
      return new OpenAiCompatibleEmbeddingProvider({
        providerId: 'openai-compatible',
        baseUrl: env.KNOWLEDGE_EMBEDDING_BASE_URL,
        model: env.KNOWLEDGE_EMBEDDING_MODEL,
        apiKey: secrets.KNOWLEDGE_EMBEDDING_API_KEY,
      });
    }
  }
}
