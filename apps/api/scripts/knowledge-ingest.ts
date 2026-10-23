import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createEmbeddingProvider } from '../src/knowledge/embedding.factory.js';
import { KnowledgeService } from '../src/knowledge/knowledge.service.js';
import { createPostgresAdapter } from '../src/persistence/postgres-adapter.js';
import type { PrismaService } from '../src/persistence/prisma.service.js';

/**
 * pnpm knowledge:ingest --tenant <uuid> --file <path> --source <name>
 *   --updated YYYY-MM-DD [--title <t>] [--topic <t>] [--language uz|ru|en]
 *   [--regulated] --confirm-provider-may-see-text
 *
 * Operator-run. The text is sent to the configured embedding provider
 * (KNOWLEDGE_EMBEDDINGS, KNOWLEDGE_EMBEDDING_MODEL, ...): with a free tier
 * that may mean the text is used to improve the provider's products, so the
 * confirmation flag is mandatory and only non-confidential text may be used.
 * At most --max-bytes (default 100000) are read. Keys are read from the
 * environment and never printed.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

function args(): Map<string, string | true> {
  const out = new Map<string, string | true>();
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const key = list[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument ${key}`);
    const next = list[i + 1];
    if (next === undefined || next.startsWith('--'))
      out.set(key.slice(2), true);
    else {
      out.set(key.slice(2), next);
      i += 1;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const a = args();
  const need = (name: string): string => {
    const value = a.get(name);
    if (typeof value !== 'string') throw new Error(`--${name} is required`);
    return value;
  };
  if (a.get('confirm-provider-may-see-text') !== true)
    throw new Error(
      'Add --confirm-provider-may-see-text: the text is sent to the embedding provider',
    );
  const maxBytes = Number(a.get('max-bytes') ?? 100_000);
  const raw = readFileSync(resolve(process.cwd(), need('file')), 'utf8');
  if (Buffer.byteLength(raw) > maxBytes)
    throw new Error(`File is larger than --max-bytes (${maxBytes})`);
  const updated = new Date(`${need('updated')}T00:00:00Z`);
  if (Number.isNaN(updated.getTime()))
    throw new Error('--updated must be YYYY-MM-DD');
  const embedder = createEmbeddingProvider({
    KNOWLEDGE_EMBEDDINGS: (process.env.KNOWLEDGE_EMBEDDINGS ?? 'off') as
      'off' | 'gemini' | 'openai-compatible' | 'hashing',
    KNOWLEDGE_EMBEDDING_MODEL: process.env.KNOWLEDGE_EMBEDDING_MODEL,
    KNOWLEDGE_EMBEDDING_BASE_URL: process.env.KNOWLEDGE_EMBEDDING_BASE_URL,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
  });
  if (!embedder)
    throw new Error(
      'Set KNOWLEDGE_EMBEDDINGS (gemini | openai-compatible) first',
    );
  const prisma = new PrismaClient({
    adapter: createPostgresAdapter(process.env),
  });
  try {
    const service = new KnowledgeService(prisma as unknown as PrismaService);
    const result = await service.ingest(
      {
        tenantId: need('tenant'),
        title: String(a.get('title') ?? need('source')),
        source: need('source'),
        sourceUpdatedAt: updated,
        text: raw,
        ...(typeof a.get('topic') === 'string'
          ? { topic: String(a.get('topic')) }
          : {}),
        ...(typeof a.get('language') === 'string'
          ? { language: String(a.get('language')) }
          : {}),
        regulated: a.get('regulated') === true,
      },
      async (texts) => {
        const embedded = await embedder.embed(texts);
        return { vectors: embedded.vectors, model: embedder.model };
      },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Ingestion failed'}\n`,
  );
  process.exitCode = 1;
});
