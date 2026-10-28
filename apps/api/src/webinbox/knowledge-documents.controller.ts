import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { EmbeddingProvider } from '../core/knowledge/embedding.js';
import { EMBEDDING_PROVIDER } from '../knowledge/embedding.factory.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { FAQ_SOURCE_PREFIX } from './knowledge-faq.controller.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

export const DOC_SOURCE_PREFIX = 'doc:';
/**
 * Text per upload. The default request body limit is 100 kB and Cyrillic is
 * two bytes per character in JSON, so longer documents are split by the
 * author; the store itself accepts 200 000 characters.
 */
export const DOC_TEXT_MAX = 40_000;
export const DOC_TITLE_MAX = 150;
const MAX_DOCS = 200;

const Upload = z.object({
  title: z
    .string()
    .transform((value) => value.replace(/\s+/gu, ' ').trim())
    .pipe(z.string().min(2).max(DOC_TITLE_MAX)),
  text: z.string().min(1).max(DOC_TEXT_MAX),
  language: z.enum(['uz', 'ru', 'en']).nullish(),
  topic: z
    .string()
    .trim()
    .max(100)
    .regex(/^[\p{L}\p{N} _-]*$/u)
    .nullish(),
  regulated: z.boolean().default(false),
  /** The text is sent to the embedding provider (see ADR 027). */
  confirmProviderMayReadText: z.literal(true),
});

export interface KnowledgeDocumentItem {
  id: string;
  title: string;
  language: string | null;
  topic: string | null;
  regulated: boolean;
  chunks: number;
  characters: number;
  /** Where it came from: uploaded in the web UI or loaded by an administrator. */
  origin: 'upload' | 'admin';
  preview: string;
  updatedAt: Date;
}

/**
 * Text documents of the knowledge base (policies, programme descriptions,
 * rules) beside the FAQ. Uploading the same title again replaces the
 * document; documents loaded by an administrator script are listed too and
 * can be withdrawn. Same rules as the FAQ: OWNER/ADMIN write, everyone
 * signed in reads, the text goes to the embedding provider only after the
 * consent flag, every change is audited, delete archives.
 */
@Controller('api/v1/knowledge/documents')
@UseGuards(SessionGuard)
export class KnowledgeDocumentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
    @Optional()
    @Inject(EMBEDDING_PROVIDER)
    private readonly embedder: EmbeddingProvider | undefined,
  ) {}

  private requireWriter(request: InboxRequest): void {
    const role = request.principal!.role;
    if (role !== 'OWNER' && role !== 'ADMIN')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
  }

  @Get()
  async list(@Req() request: InboxRequest): Promise<{
    embeddingsConfigured: boolean;
    limits: { text: number; title: number };
    items: KnowledgeDocumentItem[];
  }> {
    const rows = await this.prisma.knowledgeDocument.findMany({
      where: {
        tenantId: request.principal!.tenantId,
        status: 'ACTIVE',
        NOT: { source: { startsWith: FAQ_SOURCE_PREFIX } },
      },
      orderBy: { updatedAt: 'desc' },
      take: MAX_DOCS,
      include: {
        chunks: { orderBy: { ordinal: 'asc' }, select: { text: true } },
      },
    });
    return {
      embeddingsConfigured: Boolean(this.embedder),
      limits: { text: DOC_TEXT_MAX, title: DOC_TITLE_MAX },
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        language: row.language,
        topic: row.topic,
        regulated: row.regulated,
        chunks: row.chunks.length,
        characters: row.chunks.reduce(
          (sum, chunk) => sum + chunk.text.length,
          0,
        ),
        origin: row.source.startsWith(DOC_SOURCE_PREFIX) ? 'upload' : 'admin',
        preview: (row.chunks[0]?.text ?? '').slice(0, 200),
        updatedAt: row.updatedAt,
      })),
    };
  }

  @Post()
  async upload(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<{ id: string; chunks: number; replaced: boolean }> {
    this.requireWriter(request);
    const parsed = Upload.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    const embedder = this.embedder;
    if (!embedder)
      throw new ServiceUnavailableException({
        code: 'KNOWLEDGE_DISABLED',
        message: 'Knowledge search is not configured',
        i18nKey: 'errors.knowledgeDisabled',
      });
    const principal = request.principal!;
    const doc = parsed.data;
    // Same title, same document: uploading again replaces instead of piling up.
    const source = `${DOC_SOURCE_PREFIX}${createHash('sha256')
      .update(doc.title.toLocaleLowerCase())
      .digest('hex')
      .slice(0, 24)}`;
    const existing = await this.prisma.knowledgeDocument.findFirst({
      where: { tenantId: principal.tenantId, source },
      select: { status: true },
    });
    if (!existing) {
      const count = await this.prisma.knowledgeDocument.count({
        where: {
          tenantId: principal.tenantId,
          status: 'ACTIVE',
          NOT: { source: { startsWith: FAQ_SOURCE_PREFIX } },
        },
      });
      if (count >= MAX_DOCS)
        throw new BadRequestException({
          code: 'DOCUMENT_LIMIT',
          message: 'Too many documents',
          i18nKey: 'errors.documentLimit',
        });
    }
    let result;
    try {
      result = await this.knowledge.ingest(
        {
          tenantId: principal.tenantId,
          title: doc.title,
          source,
          sourceUpdatedAt: new Date(),
          text: doc.text,
          ...(doc.language ? { language: doc.language } : {}),
          ...(doc.topic ? { topic: doc.topic } : {}),
          regulated: doc.regulated,
          embeddingModel: embedder.model,
        },
        async (chunks) => {
          const embedded = await embedder.embed(chunks);
          return { vectors: embedded.vectors, model: embedder.model };
        },
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'EMBEDDING_FAILED',
        message: 'The embedding provider failed',
        i18nKey: 'errors.embeddingFailed',
      });
    }
    if (result.status === 'REJECTED')
      throw new BadRequestException({
        code: result.reason === 'EMPTY' ? 'INVALID_BODY' : 'DOCUMENT_TOO_LARGE',
        message: 'The document cannot be stored',
        i18nKey:
          result.reason === 'EMPTY'
            ? 'errors.invalidBody'
            : 'errors.documentTooLarge',
      });
    await this.prisma.auditEvent.create({
      data: {
        tenantId: principal.tenantId,
        actorType: 'OPERATOR',
        actorId: principal.operatorId,
        action: existing
          ? 'knowledge.document_replaced'
          : 'knowledge.document_uploaded',
        entityType: 'knowledge_document',
        entityId: result.documentId,
        safeInputSummary: {
          characters: doc.text.length,
          chunks: result.chunks,
          regulated: doc.regulated,
        },
      },
    });
    return {
      id: result.documentId,
      chunks: result.chunks,
      replaced: Boolean(existing),
    };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    this.requireWriter(request);
    const principal = request.principal!;
    const archived = await this.prisma.knowledgeDocument.updateMany({
      where: {
        tenantId: principal.tenantId,
        id,
        status: 'ACTIVE',
        NOT: { source: { startsWith: FAQ_SOURCE_PREFIX } },
      },
      data: { status: 'ARCHIVED', updatedAt: new Date() },
    });
    if (archived.count !== 1)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Not found',
        i18nKey: 'errors.notFound',
      });
    await this.prisma.auditEvent.create({
      data: {
        tenantId: principal.tenantId,
        actorType: 'OPERATOR',
        actorId: principal.operatorId,
        action: 'knowledge.document_deleted',
        entityType: 'knowledge_document',
        entityId: id,
        safeInputSummary: {},
      },
    });
  }
}
