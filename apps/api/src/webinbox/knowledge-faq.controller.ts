import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { EmbeddingProvider } from '../core/knowledge/embedding.js';
import { EMBEDDING_PROVIDER } from '../knowledge/embedding.factory.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

export const FAQ_SOURCE_PREFIX = 'faq:';
/** Question + answer must stay one chunk (maxChars 900) so an answer is read back exactly. */
export const FAQ_QUESTION_MAX = 200;
export const FAQ_ANSWER_MAX = 600;
const MAX_FAQ = 500;

const FaqEntry = z.object({
  question: z
    .string()
    .transform((value) => value.replace(/\s+/gu, ' ').trim())
    .pipe(z.string().min(3).max(FAQ_QUESTION_MAX)),
  answer: z
    .string()
    .transform((value) => value.replace(/\s+/gu, ' ').trim())
    .pipe(z.string().min(1).max(FAQ_ANSWER_MAX)),
  language: z.enum(['uz', 'ru', 'en']).nullish(),
  regulated: z.boolean().default(false),
});

/** The text is sent to the embedding provider (see ADR 027). */
const Faq = FaqEntry.extend({ confirmProviderMayReadText: z.literal(true) });

/** Entries per import request (the default body limit is 100 kB). */
export const FAQ_IMPORT_BATCH = 25;
const Import = z.object({
  entries: z.array(z.unknown()).min(1).max(FAQ_IMPORT_BATCH),
  confirmProviderMayReadText: z.literal(true),
});

export interface FaqImportResult {
  created: number;
  updated: number;
  failed: { index: number; code: string }[];
}

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  language: string | null;
  regulated: boolean;
  updatedAt: Date;
}

/**
 * FAQ entries for the web Knowledge page: one question/answer pair is one
 * knowledge document (source `faq:<uuid>`), stored as one chunk whose text is
 * the answer and whose vector embeds question + answer. The agent can only
 * ever quote the answer text as written (ADR 019); this adds no new fact path.
 * Writing is OWNER/ADMIN only and audited; deleting withdraws the entry from
 * retrieval (archive), it does not erase the audit trail.
 */
@Controller('api/v1/knowledge/faq')
@UseGuards(SessionGuard)
export class KnowledgeFaqController {
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

  private parse(body: unknown): z.infer<typeof Faq> {
    const parsed = Faq.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    return parsed.data;
  }

  @Get()
  async list(@Req() request: InboxRequest): Promise<{
    embeddingsConfigured: boolean;
    limits: { question: number; answer: number };
    items: FaqItem[];
  }> {
    const rows = await this.prisma.knowledgeDocument.findMany({
      where: {
        tenantId: request.principal!.tenantId,
        status: 'ACTIVE',
        source: { startsWith: FAQ_SOURCE_PREFIX },
      },
      orderBy: { updatedAt: 'desc' },
      take: MAX_FAQ,
      include: {
        chunks: {
          orderBy: { ordinal: 'asc' },
          take: 1,
          select: { text: true },
        },
      },
    });
    return {
      embeddingsConfigured: Boolean(this.embedder),
      limits: { question: FAQ_QUESTION_MAX, answer: FAQ_ANSWER_MAX },
      items: rows.map((row) => ({
        id: row.source.slice(FAQ_SOURCE_PREFIX.length),
        question: row.title,
        answer: row.chunks[0]?.text ?? '',
        language: row.language,
        regulated: row.regulated,
        updatedAt: row.updatedAt,
      })),
    };
  }

  @Post()
  async create(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<{ id: string }> {
    this.requireWriter(request);
    const faq = this.parse(body);
    const count = await this.prisma.knowledgeDocument.count({
      where: {
        tenantId: request.principal!.tenantId,
        status: 'ACTIVE',
        source: { startsWith: FAQ_SOURCE_PREFIX },
      },
    });
    if (count >= MAX_FAQ)
      throw new BadRequestException({
        code: 'FAQ_LIMIT',
        message: 'Too many entries',
        i18nKey: 'errors.faqLimit',
      });
    const id = randomUUID();
    await this.save(request, id, faq, 'knowledge.faq_created');
    return { id };
  }

  /**
   * Imports a batch parsed from an uploaded file (the browser parses the file;
   * the server never sees it). An entry whose question already exists
   * (ignoring case and spacing) replaces that entry, so uploading the same
   * file twice changes nothing. Entries fail one by one with a code.
   */
  @Post('import')
  async import(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<FaqImportResult> {
    this.requireWriter(request);
    const parsed = Import.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    if (!this.embedder)
      throw new ServiceUnavailableException({
        code: 'KNOWLEDGE_DISABLED',
        message: 'Knowledge search is not configured',
        i18nKey: 'errors.knowledgeDisabled',
      });
    const tenantId = request.principal!.tenantId;
    const existing = await this.prisma.knowledgeDocument.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        source: { startsWith: FAQ_SOURCE_PREFIX },
      },
      select: { source: true, title: true },
      take: MAX_FAQ,
    });
    const key = (question: string): string => question.toLocaleLowerCase();
    const byQuestion = new Map(
      existing.map((row) => [
        key(row.title),
        row.source.slice(FAQ_SOURCE_PREFIX.length),
      ]),
    );
    let total = existing.length;
    const result: FaqImportResult = { created: 0, updated: 0, failed: [] };
    let providerDown = false;
    for (const [index, raw] of parsed.data.entries.entries()) {
      if (providerDown) {
        result.failed.push({ index, code: 'EMBEDDING_FAILED' });
        continue;
      }
      const entry = FaqEntry.safeParse(raw);
      if (!entry.success) {
        result.failed.push({ index, code: 'INVALID_ENTRY' });
        continue;
      }
      const known = byQuestion.get(key(entry.data.question));
      if (!known && total >= MAX_FAQ) {
        result.failed.push({ index, code: 'FAQ_LIMIT' });
        continue;
      }
      const id = known ?? randomUUID();
      try {
        await this.save(
          request,
          id,
          { ...entry.data, confirmProviderMayReadText: true },
          known ? 'knowledge.faq_updated' : 'knowledge.faq_created',
        );
      } catch (error) {
        const code =
          error instanceof HttpException
            ? ((error.getResponse() as { code?: string }).code ?? 'FAILED')
            : 'FAILED';
        if (code === 'EMBEDDING_FAILED') providerDown = true;
        result.failed.push({ index, code });
        continue;
      }
      byQuestion.set(key(entry.data.question), id);
      if (known) result.updated += 1;
      else {
        result.created += 1;
        total += 1;
      }
    }
    return result;
  }

  @Put(':id')
  async update(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<{ id: string }> {
    this.requireWriter(request);
    const faq = this.parse(body);
    await this.requireExisting(request, id);
    await this.save(request, id, faq, 'knowledge.faq_updated');
    return { id };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    this.requireWriter(request);
    const principal = request.principal!;
    await this.requireExisting(request, id);
    const archived = await this.knowledge.archive(
      principal.tenantId,
      `${FAQ_SOURCE_PREFIX}${id}`,
    );
    if (!archived) return;
    await this.prisma.auditEvent.create({
      data: {
        tenantId: principal.tenantId,
        actorType: 'OPERATOR',
        actorId: principal.operatorId,
        action: 'knowledge.faq_deleted',
        entityType: 'knowledge_faq',
        entityId: id,
        safeInputSummary: {},
      },
    });
  }

  private async requireExisting(
    request: InboxRequest,
    id: string,
  ): Promise<void> {
    const found = await this.prisma.knowledgeDocument.findFirst({
      where: {
        tenantId: request.principal!.tenantId,
        source: `${FAQ_SOURCE_PREFIX}${id}`,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    if (!found)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Not found',
        i18nKey: 'errors.notFound',
      });
  }

  private async save(
    request: InboxRequest,
    id: string,
    faq: z.infer<typeof Faq>,
    action: string,
  ): Promise<void> {
    const embedder = this.embedder;
    if (!embedder)
      throw new ServiceUnavailableException({
        code: 'KNOWLEDGE_DISABLED',
        message: 'Knowledge search is not configured',
        i18nKey: 'errors.knowledgeDisabled',
      });
    const principal = request.principal!;
    let result;
    try {
      result = await this.knowledge.ingest(
        {
          tenantId: principal.tenantId,
          title: faq.question,
          source: `${FAQ_SOURCE_PREFIX}${id}`,
          sourceUpdatedAt: new Date(),
          // The stored passage is the answer alone: it is what the customer is shown.
          text: faq.answer,
          ...(faq.language ? { language: faq.language } : {}),
          topic: 'faq',
          regulated: faq.regulated,
          embeddingModel: embedder.model,
        },
        async (chunks) => {
          // The vector covers question + answer so questions find their answer.
          const embedded = await embedder.embed(
            chunks.map((chunk) => `${faq.question}\n${chunk}`),
          );
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
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    await this.prisma.auditEvent.create({
      data: {
        tenantId: principal.tenantId,
        actorType: 'OPERATOR',
        actorId: principal.operatorId,
        action,
        entityType: 'knowledge_faq',
        entityId: id,
        safeInputSummary: {
          questionLength: faq.question.length,
          answerLength: faq.answer.length,
          regulated: faq.regulated,
        },
      },
    });
  }
}
