import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  latestLead,
  setOperatorLeadScore,
  setOperatorLeadStatus,
} from '../leads/lead-operator.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const ScoreBody = z
  .object({ score: z.enum(['HOT', 'WARM', 'COLD']).nullable() })
  .strict();
const StatusBody = z
  .object({ status: z.enum(['NEW', 'IN_PROGRESS', 'WON', 'LOST']) })
  .strict();
const OPERATING = new Set(['OWNER', 'ADMIN', 'OPERATOR']);

/**
 * Lead board moves (ADR 037): an operator drags a lead to another score or
 * status column. Keyed by conversation, so a lead whose conversation was
 * never handed over can be moved too. Tenant-scoped, CSRF-protected by the
 * session guard, audited.
 */
@Controller('api/v1/leads/conversations')
@UseGuards(SessionGuard)
export class LeadsController {
  constructor(private readonly prisma: PrismaService) {}

  @Put(':conversationId/score')
  async score(
    @Req() request: InboxRequest,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body() body: unknown,
  ): Promise<{ score: string | null }> {
    const parsed = ScoreBody.safeParse(body);
    if (!parsed.success) throw invalid();
    const score = parsed.data.score;
    await this.change(
      request,
      conversationId,
      'operator.set_lead_score',
      {
        leadScore: score ?? 'AUTO',
      },
      async (tx, tenantId, lead) =>
        setOperatorLeadScore(tx, tenantId, lead, score),
    );
    return { score };
  }

  @Put(':conversationId/status')
  async status(
    @Req() request: InboxRequest,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    const parsed = StatusBody.safeParse(body);
    if (!parsed.success) throw invalid();
    const status = parsed.data.status;
    await this.change(
      request,
      conversationId,
      'operator.set_lead_status',
      {
        leadStatus: status,
      },
      async (tx, tenantId, lead) =>
        setOperatorLeadStatus(tx, tenantId, lead, status),
    );
    return { status };
  }

  private async change(
    request: InboxRequest,
    conversationId: string,
    action: string,
    summary: Record<string, string>,
    apply: (
      tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
      tenantId: string,
      lead: { id: string; crmSyncStatus: string },
    ) => Promise<void>,
  ): Promise<void> {
    const principal = request.principal!;
    if (!OPERATING.has(principal.role))
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    await this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { tenantId: principal.tenantId, id: conversationId },
        select: { id: true },
      });
      if (!conversation)
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Conversation not found',
          i18nKey: 'errors.notFound',
        });
      const lead = await latestLead(tx, principal.tenantId, conversationId);
      if (!lead)
        throw new ConflictException({
          code: 'NO_LEAD',
          message: 'This conversation has no lead yet',
          i18nKey: 'errors.NO_LEAD',
        });
      await apply(tx, principal.tenantId, lead);
      await tx.auditEvent.create({
        data: {
          tenantId: principal.tenantId,
          actorType: 'OPERATOR',
          actorId: principal.operatorId,
          action,
          entityType: 'lead',
          entityId: lead.id,
          safeInputSummary: { ...summary, via: 'lead_board' },
        },
      });
    });
  }
}

function invalid(): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_BODY',
    message: 'Invalid body',
    i18nKey: 'errors.invalidBody',
  });
}
