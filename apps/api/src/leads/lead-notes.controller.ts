import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  ForbiddenException,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../persistence/prisma.service.js';
import { SessionGuard, type InboxRequest } from '../webinbox/session.guard.js';

const MAX_NOTE = 4096;
const NOTE_LIMIT = 200;
const NoteBody = z.object({ text: z.string().trim().min(1).max(MAX_NOTE) });

export interface LeadNoteView {
  id: string;
  text: string;
  createdAt: string;
  author: { id: string; displayName: string } | null;
}

/**
 * Internal notes of a lead's conversation, readable and writable without a
 * handover (a hand-added lead has none). Same table as the inbox notes.
 */
@Controller('api/v1/leads/:leadId/notes')
@UseGuards(SessionGuard)
export class LeadNotesController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async conversationOf(
    tenantId: string,
    leadId: string,
  ): Promise<string> {
    const lead = await this.prisma.lead.findFirst({
      where: { tenantId, id: leadId },
      select: { conversationId: true },
    });
    if (!lead)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Not found',
        i18nKey: 'errors.notFound',
      });
    return lead.conversationId;
  }

  @Get()
  async list(
    @Req() request: InboxRequest,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
  ): Promise<{ items: LeadNoteView[] }> {
    const { tenantId } = request.principal!;
    const conversationId = await this.conversationOf(tenantId, leadId);
    const rows = await this.prisma.internalNote.findMany({
      where: { tenantId, conversationId },
      orderBy: { createdAt: 'desc' },
      take: NOTE_LIMIT,
      select: { id: true, text: true, createdAt: true, operatorId: true },
    });
    const ids = [...new Set(rows.map((r) => r.operatorId))];
    const operators =
      ids.length === 0
        ? []
        : await this.prisma.operator.findMany({
            where: { tenantId, id: { in: ids } },
            select: { id: true, displayName: true },
          });
    const byId = new Map(operators.map((o) => [o.id, o]));
    return {
      items: rows.map((r) => ({
        id: r.id,
        text: r.text,
        createdAt: r.createdAt.toISOString(),
        author: byId.get(r.operatorId) ?? null,
      })),
    };
  }

  @Post()
  async add(
    @Req() request: InboxRequest,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: unknown,
  ): Promise<LeadNoteView> {
    const { tenantId, operatorId, role } = request.principal!;
    if (role === 'VIEWER')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Forbidden',
        i18nKey: 'errors.forbidden',
      });
    const parsed = NoteBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Body must be { "text": string }',
        i18nKey: 'errors.invalidBody',
      });
    const conversationId = await this.conversationOf(tenantId, leadId);
    const note = await this.prisma.$transaction(async (tx) => {
      const created = await tx.internalNote.create({
        data: {
          tenantId,
          conversationId,
          operatorId,
          text: parsed.data.text,
          idempotencyKey: `lead-note:${randomUUID()}`,
        },
        select: { id: true, text: true, createdAt: true },
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'OPERATOR',
          actorId: operatorId,
          action: 'lead.note.added',
          entityType: 'lead',
          entityId: leadId,
          // The note text is customer-related: only its length is recorded.
          safeInputSummary: { length: parsed.data.text.length },
        },
      });
      return created;
    });
    const author = await this.prisma.operator.findFirst({
      where: { tenantId, id: operatorId },
      select: { id: true, displayName: true },
    });
    return {
      id: note.id,
      text: note.text,
      createdAt: note.createdAt.toISOString(),
      author,
    };
  }
}
