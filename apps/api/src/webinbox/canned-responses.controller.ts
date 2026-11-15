import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../persistence/prisma.service.js';
import { forbidden, invalidBody, notFound } from '../tags/tag-errors.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

/** A guard against runaway lists, not a product limit. */
export const MAX_CANNED_RESPONSES = 200;
export const CANNED_TITLE_MAX = 80;
export const CANNED_TEXT_MAX = 2000;

export interface CannedResponseItem {
  id: string;
  title: string;
  text: string;
  position: number;
}

const Title = z.string().trim().min(1).max(CANNED_TITLE_MAX);
const Text = z.string().trim().min(1).max(CANNED_TEXT_MAX);
const CreateBody = z.object({ title: Title, text: Text }).strict();
const UpdateBody = z
  .object({
    title: Title.optional(),
    text: Text.optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0);

const SELECT = { id: true, title: true, text: true, position: true } as const;

function manager(
  request: InboxRequest,
): NonNullable<InboxRequest['principal']> {
  const principal = request.principal!;
  if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
    throw forbidden();
  return principal;
}

/**
 * Quick replies of a workspace (roadmap P1.8, ADR 070): every signed-in role
 * reads them in the composer; OWNER and ADMIN write them. Operator text, sent
 * only when an operator chooses to; never shown to the customer by the
 * assistant. Tenant from the session only; every write is audited (title
 * only, never the text).
 */
@Controller('api/v1/canned-responses')
@UseGuards(SessionGuard)
export class CannedResponsesController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Req() request: InboxRequest,
  ): Promise<{ items: CannedResponseItem[] }> {
    const items = await this.prisma.cannedResponse.findMany({
      where: { tenantId: request.principal!.tenantId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      take: MAX_CANNED_RESPONSES,
      select: SELECT,
    });
    return { items };
  }

  @Post()
  async create(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<CannedResponseItem> {
    const { tenantId, operatorId } = manager(request);
    const parsed = CreateBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    return this.prisma.$transaction(async (tx) => {
      // One writer per workspace at a time, so the cap and the position hold.
      await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`agentcore:canned:${tenantId}`}, 0))) AS lock_result`;
      const count = await tx.cannedResponse.count({ where: { tenantId } });
      if (count >= MAX_CANNED_RESPONSES)
        throw new ConflictException({
          code: 'CANNED_LIMIT',
          message: 'Too many quick replies',
          i18nKey: 'errors.cannedLimit',
        });
      const last = await tx.cannedResponse.aggregate({
        where: { tenantId },
        _max: { position: true },
      });
      const item = await tx.cannedResponse.create({
        data: {
          tenantId,
          title: parsed.data.title,
          text: parsed.data.text,
          position: (last._max.position ?? -1) + 1,
        },
        select: SELECT,
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'OPERATOR',
          actorId: operatorId,
          action: 'canned_response.created',
          entityType: 'canned_response',
          entityId: item.id,
          safeInputSummary: { title: item.title },
        },
      });
      return item;
    });
  }

  @Patch(':id')
  async update(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<CannedResponseItem> {
    const { tenantId, operatorId } = manager(request);
    const parsed = UpdateBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.cannedResponse.updateMany({
        where: { tenantId, id },
        data: parsed.data,
      });
      if (changed.count === 0) throw notFound();
      const item = await tx.cannedResponse.findFirstOrThrow({
        where: { tenantId, id },
        select: SELECT,
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'OPERATOR',
          actorId: operatorId,
          action: 'canned_response.updated',
          entityType: 'canned_response',
          entityId: id,
          safeInputSummary: { title: item.title },
        },
      });
      return item;
    });
  }

  @Delete(':id')
  async remove(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ id: string }> {
    const { tenantId, operatorId } = manager(request);
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.cannedResponse.findFirst({
        where: { tenantId, id },
        select: { title: true },
      });
      if (!found) throw notFound();
      await tx.cannedResponse.deleteMany({ where: { tenantId, id } });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'OPERATOR',
          actorId: operatorId,
          action: 'canned_response.deleted',
          entityType: 'canned_response',
          entityId: id,
          safeInputSummary: { title: found.title },
        },
      });
      return { id };
    });
  }
}
