import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { HashingEmbeddingProvider } from '../llm/embeddings/hashing-embedding-provider.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import type { MeteredLlm } from '../core/llm/metered-llm.js';
import { KnowledgeRetriever } from './knowledge-retriever.js';
import { KnowledgeService } from './knowledge.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Knowledge integration tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const service = new KnowledgeService(db as unknown as PrismaService);
const embedder = new HashingEmbeddingProvider(64);
afterAll(async () => {
  await db.$disconnect();
});

const embed = async (
  texts: readonly string[],
): Promise<{ vectors: readonly (readonly number[])[]; model: string }> => ({
  vectors: (await embedder.embed(texts)).vectors,
  model: embedder.model,
});
async function tenant(): Promise<string> {
  const t = await db.tenant.create({
    data: {
      slug: `kn-${randomUUID()}`,
      name: 'Knowledge fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  return t.id;
}
const query = async (text: string): Promise<number[]> => [
  ...(await embedder.embed([text])).vectors[0],
];
const UPDATED = new Date('2026-09-01T00:00:00Z');
const REFUND =
  'Refund policy. A student may cancel within the first week of lessons and ask for the remaining lessons to be refunded.\n\nAfter the first week refunds are decided case by case by the administrator.';
const HOURS =
  'Opening hours. The office is open from Monday to Saturday. Visitors are welcome without an appointment on weekdays.';

describe('embedding model changes', () => {
  const otherModel = Object.assign(new HashingEmbeddingProvider(64), {
    model: 'hashing-test-embedder-v2',
  });
  const stubLlm = (e: HashingEmbeddingProvider): MeteredLlm =>
    ({
      embed: async (_: unknown, texts: readonly string[]) =>
        (await e.embed(texts)).vectors.map((v) => [...v]),
    }) as unknown as MeteredLlm;

  it('reports re-embedding as unavailable knowledge, not as "no knowledge"', async () => {
    const tenantId = await tenant();
    await service.ingest(
      {
        tenantId,
        title: 'T',
        source: 'S',
        sourceUpdatedAt: UPDATED,
        text: REFUND,
      },
      embed,
    );
    expect(await service.modelCoverage(tenantId, embedder.model)).toEqual({
      activeDocuments: 1,
      withModel: 1,
    });
    expect(await service.modelCoverage(tenantId, otherModel.model)).toEqual({
      activeDocuments: 1,
      withModel: 0,
    });
    const current = new KnowledgeRetriever(
      service,
      embedder,
      stubLlm(embedder),
      tenantId,
    );
    expect(await current.search('refund lessons cancel')).toMatchObject({
      ok: true,
    });
    const changed = new KnowledgeRetriever(
      service,
      otherModel,
      stubLlm(otherModel),
      tenantId,
    );
    expect(await changed.search('refund lessons cancel')).toEqual({
      ok: false,
      code: 'EMBEDDING_MODEL_MISMATCH',
    });
    // A tenant with no knowledge at all is genuinely empty.
    const empty = new KnowledgeRetriever(
      service,
      otherModel,
      stubLlm(otherModel),
      await tenant(),
    );
    expect(await empty.search('anything')).toEqual({ ok: true, passages: [] });
  });

  it('works again once the source is re-ingested with the new model', async () => {
    const tenantId = await tenant();
    await service.ingest(
      {
        tenantId,
        title: 'T',
        source: 'S',
        sourceUpdatedAt: UPDATED,
        text: REFUND,
      },
      embed,
    );
    await service.ingest(
      {
        tenantId,
        title: 'T',
        source: 'S',
        sourceUpdatedAt: UPDATED,
        text: REFUND,
      },
      async (texts) => ({
        vectors: (await otherModel.embed(texts)).vectors,
        model: otherModel.model,
      }),
    );
    const retriever = new KnowledgeRetriever(
      service,
      otherModel,
      stubLlm(otherModel),
      tenantId,
    );
    const result = await retriever.search('refund lessons cancel');
    expect(result.ok && result.passages.length).toBeGreaterThan(0);
  });
});

describe('pgvector prerequisites', () => {
  it('has the extension installed in the test database', async () => {
    const rows = await db.$queryRaw<
      Array<{ extname: string }>
    >`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    expect(rows).toHaveLength(1);
  });
});

describe('knowledge store (PostgreSQL + pgvector)', () => {
  it('ingests, retrieves the closest passage with its source and date, and ignores unrelated text', async () => {
    const tenantId = await tenant();
    const first = await service.ingest(
      {
        tenantId,
        title: 'Refunds',
        source: 'Refund policy',
        sourceUpdatedAt: UPDATED,
        text: REFUND,
        topic: 'refunds',
      },
      embed,
    );
    await service.ingest(
      {
        tenantId,
        title: 'Hours',
        source: 'Opening hours',
        sourceUpdatedAt: UPDATED,
        text: HOURS,
        topic: 'visit',
      },
      embed,
    );
    expect(first).toMatchObject({ status: 'INGESTED' });
    const hits = await service.search(
      tenantId,
      await query('can I get a refund for lessons?'),
      {
        model: embedder.model,
        limit: 2,
      },
    );
    expect(hits[0]).toMatchObject({
      source: 'Refund policy',
      updatedAt: UPDATED.toISOString(),
      regulated: false,
      topic: 'refunds',
    });
    expect(hits[0].text).toContain('Refund policy');
    expect(hits[0].score).toBeGreaterThan(hits[hits.length - 1].score - 1e-9);
    const visit = await service.search(
      tenantId,
      await query('office opening hours'),
      {
        model: embedder.model,
        limit: 1,
      },
    );
    expect(visit[0].source).toBe('Opening hours');
  });

  it('is idempotent, replaces a changed source, and does not keep stale passages', async () => {
    const tenantId = await tenant();
    const input = {
      tenantId,
      title: 'Refunds',
      source: 'Refund policy',
      sourceUpdatedAt: UPDATED,
      text: REFUND,
      embeddingModel: embedder.model,
    };
    const a = await service.ingest(input, embed);
    const again = await service.ingest(input, embed);
    expect(again).toMatchObject({
      status: 'UNCHANGED',
      documentId: (a as { documentId: string }).documentId,
    });
    await service.ingest(
      {
        ...input,
        text: 'Refund policy v2. Cancellation is possible during the first two weeks.',
        sourceUpdatedAt: new Date('2026-10-01T00:00:00Z'),
      },
      embed,
    );
    const hits = await service.search(
      tenantId,
      await query('refund policy cancellation'),
      { model: embedder.model, limit: 5 },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain('two weeks');
    expect(hits[0].updatedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(await db.knowledgeDocument.count({ where: { tenantId } })).toBe(1);
  });

  it('never returns another tenant’s text, archived text, or vectors of another model', async () => {
    const a = await tenant();
    const b = await tenant();
    await service.ingest(
      {
        tenantId: a,
        title: 'T',
        source: 'S',
        sourceUpdatedAt: UPDATED,
        text: REFUND,
      },
      embed,
    );
    const q = await query('refund lessons cancel');
    expect(await service.search(b, q, { model: embedder.model })).toEqual([]);
    expect(
      (await service.search(a, q, { model: embedder.model })).length,
    ).toBeGreaterThan(0);
    expect(await service.search(a, q, { model: 'some-other-model' })).toEqual(
      [],
    );
    expect(
      await service.search(a, q.slice(0, 32), { model: embedder.model }),
    ).toEqual([]); // other length
    expect(await service.archive(a, 'S')).toBe(true);
    expect(await service.search(a, q, { model: embedder.model })).toEqual([]);
    expect(await service.archive(b, 'S')).toBe(false);
  });

  it('filters by topic and flags regulated documents', async () => {
    const tenantId = await tenant();
    await service.ingest(
      {
        tenantId,
        title: 'Visa',
        source: 'Visa rules',
        sourceUpdatedAt: UPDATED,
        text: 'Visa rules. Check the embassy site.',
        topic: 'visa',
        regulated: true,
      },
      embed,
    );
    await service.ingest(
      {
        tenantId,
        title: 'Hours',
        source: 'Hours',
        sourceUpdatedAt: UPDATED,
        text: HOURS,
        topic: 'visit',
      },
      embed,
    );
    const q = await query('rules for travel');
    const visa = await service.search(tenantId, q, {
      model: embedder.model,
      topic: 'visa',
    });
    expect(visa).toHaveLength(1);
    expect(visa[0]).toMatchObject({ regulated: true, topic: 'visa' });
  });

  it('rejects empty and oversized documents without writing', async () => {
    const tenantId = await tenant();
    expect(
      await service.ingest(
        {
          tenantId,
          title: 'x',
          source: 'e',
          sourceUpdatedAt: UPDATED,
          text: '   ',
        },
        embed,
      ),
    ).toEqual({ status: 'REJECTED', reason: 'EMPTY' });
    expect(
      await service.ingest(
        {
          tenantId,
          title: 'x',
          source: 'big',
          sourceUpdatedAt: UPDATED,
          text: 'a'.repeat(200_001),
        },
        embed,
      ),
    ).toEqual({ status: 'REJECTED', reason: 'TOO_LARGE' });
    expect(await db.knowledgeDocument.count({ where: { tenantId } })).toBe(0);
  });

  it('rolls back completely when the embedder fails or returns the wrong shape', async () => {
    const tenantId = await tenant();
    await expect(
      service.ingest(
        {
          tenantId,
          title: 'x',
          source: 'f',
          sourceUpdatedAt: UPDATED,
          text: REFUND,
        },
        () => Promise.reject(new Error('down')),
      ),
    ).rejects.toThrow('down');
    await expect(
      service.ingest(
        {
          tenantId,
          title: 'x',
          source: 'f',
          sourceUpdatedAt: UPDATED,
          text: REFUND,
        },
        () =>
          Promise.resolve({
            vectors: [
              [1, 2],
              [3, 4],
            ],
            model: 'm',
          }),
      ),
    ).rejects.toThrow();
    expect(await db.knowledgeDocument.count({ where: { tenantId } })).toBe(0);
    expect(await db.knowledgeChunk.count({ where: { tenantId } })).toBe(0);
  });
});
