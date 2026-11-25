import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../persistence/prisma.service.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

/** How far back unanswered questions are listed. */
export const GAP_WINDOW_DAYS = 14;
const MAX_TURNS = 500;
const MAX_ITEMS = 50;

export type KnowledgeGap = {
  /** The turns that asked it (same text, ignoring case and spacing). */
  readonly ids: string[];
  readonly question: string;
  readonly count: number;
  readonly lastAskedAt: Date;
  readonly conversationId: string;
};

const ResolveBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(MAX_TURNS),
  resolution: z.enum(['ANSWERED', 'DISMISSED']),
});

/** Questions the bot handed over for lack of data, the same text counted once. */
export function groupGaps(
  rows: ReadonlyArray<{
    id: string;
    question: string;
    askedAt: Date;
    conversationId: string;
  }>,
): KnowledgeGap[] {
  const groups = new Map<string, KnowledgeGap>();
  // Rows come newest first, so a group's first row is its latest.
  for (const row of rows) {
    const question = row.question.replace(/\s+/gu, ' ').trim();
    if (!question) continue;
    const key = question.toLocaleLowerCase();
    const group = groups.get(key);
    groups.set(
      key,
      group
        ? { ...group, ids: [...group.ids, row.id], count: group.count + 1 }
        : {
            ids: [row.id],
            question,
            count: 1,
            lastAskedAt: row.askedAt,
            conversationId: row.conversationId,
          },
    );
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        b.count - a.count || b.lastAskedAt.getTime() - a.lastAskedAt.getTime(),
    )
    .slice(0, MAX_ITEMS);
}

/**
 * ADR 091: what customers asked that the bot could not answer (a NO_DATA
 * hand-over), so the owner can add the answer as a FAQ entry or dismiss it.
 * Customer text is untrusted and only shown, never interpreted.
 */
@Controller('api/v1/knowledge/gaps')
@UseGuards(SessionGuard)
export class KnowledgeGapsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Req() request: InboxRequest): Promise<{ items: KnowledgeGap[] }> {
    const tenantId = request.principal!.tenantId;
    const since = new Date(Date.now() - GAP_WINDOW_DAYS * 86_400_000);
    const turns = await this.prisma.agentTurn.findMany({
      where: {
        tenantId,
        status: 'COMMITTED',
        outcome: 'HANDOVER',
        handoverReason: 'NO_DATA',
        gapResolution: null,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_TURNS,
      select: {
        id: true,
        conversationId: true,
        answeredSequence: true,
        createdAt: true,
      },
    });
    if (turns.length === 0) return { items: [] };
    const messages = await this.prisma.message.findMany({
      where: {
        tenantId,
        direction: 'INBOUND',
        OR: turns.map((turn) => ({
          conversationId: turn.conversationId,
          sequence: turn.answeredSequence,
        })),
      },
      select: { conversationId: true, sequence: true, text: true },
    });
    const text = new Map(
      messages.map((m) => [`${m.conversationId}:${m.sequence}`, m.text]),
    );
    return {
      items: groupGaps(
        turns.map((turn) => ({
          id: turn.id,
          conversationId: turn.conversationId,
          askedAt: turn.createdAt,
          question:
            text.get(`${turn.conversationId}:${turn.answeredSequence}`) ?? '',
        })),
      ),
    };
  }

  /** OWNER/ADMIN only; ANSWERED after a FAQ entry was saved, or DISMISSED. */
  @Post('resolve')
  async resolve(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<{ resolved: number }> {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    const parsed = ResolveBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    return this.prisma.$transaction(async (tx) => {
      const done = await tx.agentTurn.updateMany({
        where: {
          tenantId: principal.tenantId,
          id: { in: parsed.data.ids },
          gapResolution: null,
        },
        data: {
          gapResolution: parsed.data.resolution,
          gapResolvedAt: new Date(),
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: principal.tenantId,
          actorType: 'OPERATOR',
          actorId: principal.operatorId,
          action: 'knowledge.gap_resolved',
          entityType: 'tenant',
          entityId: principal.tenantId,
          safeInputSummary: {
            resolution: parsed.data.resolution,
            count: done.count,
          },
        },
      });
      return { resolved: done.count };
    });
  }
}
