import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  chunkText,
  DEFAULT_CHUNK_OPTIONS,
} from '../core/knowledge/chunking.js';
import { assertUniformVectors } from '../core/knowledge/embedding.js';
import type { KnowledgePassage } from '../core/knowledge/passage.js';

export const MAX_DOCUMENT_CHARS = 200_000;
export const MAX_CHUNKS_PER_DOCUMENT = 400;

export interface IngestInput {
  readonly tenantId: string;
  readonly title: string;
  /** Internal attribution, unique per tenant ("Admissions policy"). */
  readonly source: string;
  /** When the source text was last verified or changed. */
  readonly sourceUpdatedAt: Date;
  readonly text: string;
  readonly language?: string;
  readonly topic?: string;
  readonly regulated?: boolean;
}

export type IngestResult =
  | {
      readonly status: 'INGESTED' | 'UNCHANGED';
      readonly documentId: string;
      readonly chunks: number;
    }
  | {
      readonly status: 'REJECTED';
      readonly reason: 'EMPTY' | 'TOO_LARGE' | 'TOO_MANY_CHUNKS';
    };

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Tenant-scoped knowledge store on pgvector. Ingestion embeds BEFORE it
 * opens the write transaction, replaces a source's chunks atomically, and is
 * a no-op when the same text was already ingested with the same model.
 * Retrieval filters by tenant, active status, model and vector length, so
 * another tenant's text or another model's vectors can never be returned.
 */
@Injectable()
export class KnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(
    input: IngestInput,
    embed: (
      texts: readonly string[],
    ) => Promise<{ vectors: readonly (readonly number[])[]; model: string }>,
  ): Promise<IngestResult> {
    const text = input.text.trim();
    if (text.length === 0) return { status: 'REJECTED', reason: 'EMPTY' };
    if (text.length > MAX_DOCUMENT_CHARS)
      return { status: 'REJECTED', reason: 'TOO_LARGE' };
    const chunks = chunkText(text, DEFAULT_CHUNK_OPTIONS);
    if (chunks.length === 0) return { status: 'REJECTED', reason: 'EMPTY' };
    if (chunks.length > MAX_CHUNKS_PER_DOCUMENT)
      return { status: 'REJECTED', reason: 'TOO_MANY_CHUNKS' };
    const contentHash = createHash('sha256')
      .update(
        JSON.stringify([
          input.title,
          text,
          input.sourceUpdatedAt.toISOString(),
          input.language ?? null,
          input.topic ?? null,
          input.regulated ?? false,
        ]),
      )
      .digest('hex');
    const existing = await this.prisma.knowledgeDocument.findFirst({
      where: { tenantId: input.tenantId, source: input.source },
      select: { id: true, contentHash: true, status: true },
    });
    if (existing?.contentHash === contentHash && existing.status === 'ACTIVE') {
      const count = await this.prisma.knowledgeChunk.count({
        where: { tenantId: input.tenantId, documentId: existing.id },
      });
      if (count === chunks.length)
        return { status: 'UNCHANGED', documentId: existing.id, chunks: count };
    }
    const { vectors, model } = await embed(chunks); // before any transaction
    const dims = assertUniformVectors(vectors, chunks.length);
    return this.prisma.$transaction(async (tx) => {
      const document = await tx.knowledgeDocument.upsert({
        where: {
          tenantId_source: { tenantId: input.tenantId, source: input.source },
        },
        create: {
          tenantId: input.tenantId,
          title: input.title.slice(0, 300),
          source: input.source.slice(0, 300),
          sourceUpdatedAt: input.sourceUpdatedAt,
          language: input.language ?? null,
          topic: input.topic ?? null,
          regulated: input.regulated ?? false,
          contentHash,
        },
        update: {
          title: input.title.slice(0, 300),
          sourceUpdatedAt: input.sourceUpdatedAt,
          language: input.language ?? null,
          topic: input.topic ?? null,
          regulated: input.regulated ?? false,
          status: 'ACTIVE',
          contentHash,
          updatedAt: new Date(),
        },
        select: { id: true },
      });
      await tx.knowledgeChunk.deleteMany({
        where: { tenantId: input.tenantId, documentId: document.id },
      });
      for (let ordinal = 0; ordinal < chunks.length; ordinal++) {
        await tx.$executeRaw`
          INSERT INTO knowledge_chunks
            (id, tenant_id, document_id, ordinal, text, embedding, embedding_model, embedding_dims)
          VALUES
            (gen_random_uuid(), ${input.tenantId}::uuid, ${document.id}::uuid, ${ordinal},
             ${chunks[ordinal]}, ${vectorLiteral(vectors[ordinal])}::vector, ${model.slice(0, 100)}, ${dims})`;
      }
      return {
        status: 'INGESTED',
        documentId: document.id,
        chunks: chunks.length,
      } as const;
    });
  }

  /** Withdraws a source from retrieval; chunks stay for audit and re-ingest. */
  async archive(tenantId: string, source: string): Promise<boolean> {
    const result = await this.prisma.knowledgeDocument.updateMany({
      where: { tenantId, source, status: 'ACTIVE' },
      data: { status: 'ARCHIVED', updatedAt: new Date() },
    });
    return result.count === 1;
  }

  async search(
    tenantId: string,
    queryVector: readonly number[],
    options: {
      model: string;
      limit?: number;
      topic?: string;
      minScore?: number;
    },
  ): Promise<KnowledgePassage[]> {
    const limit = Math.min(Math.max(options.limit ?? 4, 1), 10);
    const literal = vectorLiteral(queryVector);
    const rows = await this.prisma.$queryRaw<
      Array<{
        documentId: string;
        text: string;
        title: string;
        source: string;
        updatedAt: Date;
        regulated: boolean;
        topic: string | null;
        score: number;
      }>
    >(Prisma.sql`
      SELECT d.id AS "documentId", c.text AS text, d.title AS title, d.source AS source,
             d.source_updated_at AS "updatedAt", d.regulated AS regulated, d.topic AS topic,
             (1 - (c.embedding <=> ${literal}::vector))::float8 AS score
      FROM knowledge_chunks c
      JOIN knowledge_documents d ON d.tenant_id = c.tenant_id AND d.id = c.document_id
      WHERE c.tenant_id = ${tenantId}::uuid
        AND d.status = 'ACTIVE'
        AND c.embedding_model = ${options.model}
        AND c.embedding_dims = ${queryVector.length}
        ${options.topic ? Prisma.sql`AND d.topic = ${options.topic}` : Prisma.empty}
      ORDER BY c.embedding <=> ${literal}::vector
      LIMIT ${limit}
    `);
    const min = options.minScore ?? -1;
    return rows
      .filter((row) => row.score >= min)
      .map((row) => ({
        documentId: row.documentId,
        text: row.text,
        title: row.title,
        source: row.source,
        updatedAt: row.updatedAt.toISOString(),
        regulated: row.regulated,
        topic: row.topic,
        score: row.score,
      }));
  }
}
