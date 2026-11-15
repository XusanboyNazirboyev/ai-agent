import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { SessionGuard, type InboxRequest } from '../webinbox/session.guard.js';

/**
 * The activity timeline of one lead (roadmap P1.7, ADR 069): what happened,
 * newest first, from the records that already exist (audit of lead changes,
 * tasks, internal notes, handovers, messages). A read model built when asked,
 * not a second copy: nothing can drift, and a deleted task or note simply
 * leaves the timeline.
 */

export type TimelineKind =
  | 'lead.created'
  | 'stage.moved'
  | 'lead.updated'
  | 'lead.archived'
  | 'task.created'
  | 'task.done'
  | 'note'
  | 'handover.opened'
  | 'handover.taken'
  | 'handover.resolved'
  | 'message';

export type TimelineActor = 'customer' | 'assistant' | 'operator' | 'system';

export interface TimelineStage {
  id: string;
  code: string | null;
  name: string | null;
  kind: string;
}

export interface TimelineEntry {
  id: string;
  at: string;
  kind: TimelineKind;
  actor: TimelineActor;
  actorName: string | null;
  /** Plain text to show (a note, a task title, a message preview); never HTML. */
  text: string | null;
  from: TimelineStage | null;
  to: TimelineStage | null;
  reasonCode: string | null;
}

/** Newest entries returned; older history stays in the conversation itself. */
export const TIMELINE_LIMIT = 150;
/** Messages are many; only the newest few appear between the other events. */
export const TIMELINE_MESSAGES = 40;
export const PREVIEW_CHARS = 120;

export function preview(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > PREVIEW_CHARS
    ? `${flat.slice(0, PREVIEW_CHARS - 1)}…`
    : flat;
}

/** Newest first; at the same instant the id decides, so the order is stable. */
export function sortTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  return [...entries]
    .sort((a, b) =>
      a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at),
    )
    .slice(0, TIMELINE_LIMIT);
}

const AUDIT_KINDS: Record<string, TimelineKind> = {
  'lead.stage.moved': 'stage.moved',
  'lead.opportunity.updated': 'lead.updated',
  'lead.owner_cleared': 'lead.updated',
  'lead.archived': 'lead.archived',
  'lead.created_manually': 'lead.created',
};

const MESSAGE_ACTOR: Record<string, TimelineActor> = {
  CUSTOMER: 'customer',
  BOT: 'assistant',
  OPERATOR: 'operator',
  SYSTEM: 'system',
};

function entry(
  partial: Pick<TimelineEntry, 'id' | 'at' | 'kind' | 'actor'> &
    Partial<TimelineEntry>,
): TimelineEntry {
  return {
    actorName: null,
    text: null,
    from: null,
    to: null,
    reasonCode: null,
    ...partial,
  };
}

function summaryString(summary: unknown, key: string): string | null {
  if (summary === null || typeof summary !== 'object') return null;
  const value = (summary as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

@Controller('api/v1')
@UseGuards(SessionGuard)
export class LeadTimelineController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('leads/:leadId/timeline')
  async timeline(
    @Req() request: InboxRequest,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
  ): Promise<{ items: TimelineEntry[] }> {
    const { tenantId } = request.principal!;
    const lead = await this.prisma.lead.findFirst({
      where: { tenantId, id: leadId },
      select: { id: true, conversationId: true, createdAt: true },
    });
    if (!lead)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Not found',
        i18nKey: 'errors.notFound',
      });
    const conversationId = lead.conversationId;
    const [audits, tasks, notes, handovers, messages] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where: {
          tenantId,
          entityType: 'lead',
          entityId: lead.id,
          action: { in: Object.keys(AUDIT_KINDS) },
        },
        orderBy: { createdAt: 'desc' },
        take: TIMELINE_LIMIT,
        select: {
          id: true,
          action: true,
          actorType: true,
          actorId: true,
          safeInputSummary: true,
          createdAt: true,
        },
      }),
      this.prisma.leadTask.findMany({
        where: { tenantId, leadId: lead.id },
        orderBy: { createdAt: 'desc' },
        take: TIMELINE_LIMIT,
        select: {
          id: true,
          title: true,
          createdAt: true,
          doneAt: true,
          createdByOperatorId: true,
        },
      }),
      this.prisma.internalNote.findMany({
        where: { tenantId, conversationId },
        orderBy: { createdAt: 'desc' },
        take: TIMELINE_LIMIT,
        select: { id: true, text: true, operatorId: true, createdAt: true },
      }),
      this.prisma.handover.findMany({
        where: { tenantId, conversationId },
        orderBy: { openedAt: 'desc' },
        take: TIMELINE_LIMIT,
        select: {
          id: true,
          reasonCode: true,
          openedAt: true,
          takenAt: true,
          resolvedAt: true,
          assignedOperatorId: true,
        },
      }),
      this.prisma.message.findMany({
        where: { tenantId, conversationId },
        orderBy: { createdAt: 'desc' },
        take: TIMELINE_MESSAGES,
        select: { id: true, text: true, authorType: true, createdAt: true },
      }),
    ]);

    const stageIds = new Set<string>();
    const operatorIds = new Set<string>();
    for (const audit of audits) {
      for (const key of ['from', 'to']) {
        const id = summaryString(audit.safeInputSummary, key);
        if (id) stageIds.add(id);
      }
      if (audit.actorType === 'OPERATOR' && audit.actorId)
        operatorIds.add(audit.actorId);
    }
    for (const task of tasks)
      if (task.createdByOperatorId) operatorIds.add(task.createdByOperatorId);
    for (const note of notes) operatorIds.add(note.operatorId);
    for (const handover of handovers)
      if (handover.assignedOperatorId)
        operatorIds.add(handover.assignedOperatorId);

    const uuid = /^[0-9a-f-]{36}$/iu;
    const [stages, operators] = await Promise.all([
      this.prisma.leadStage.findMany({
        where: {
          tenantId,
          id: { in: [...stageIds].filter((id) => uuid.test(id)) },
        },
        select: { id: true, code: true, name: true, kind: true },
      }),
      this.prisma.operator.findMany({
        where: {
          tenantId,
          id: { in: [...operatorIds].filter((id) => uuid.test(id)) },
        },
        select: { id: true, displayName: true },
      }),
    ]);
    const stageById = new Map(stages.map((s) => [s.id, s]));
    const nameOf = new Map(operators.map((o) => [o.id, o.displayName]));
    const stageOf = (id: string | null): TimelineStage | null =>
      id ? (stageById.get(id) ?? null) : null;
    const operatorName = (id: string | null | undefined): string | null =>
      id ? (nameOf.get(id) ?? null) : null;

    const items: TimelineEntry[] = [];
    let createdByOperator = false;
    for (const audit of audits) {
      const kind = AUDIT_KINDS[audit.action]!;
      if (kind === 'lead.created') createdByOperator = true;
      const byOperator = audit.actorType === 'OPERATOR';
      const reason = summaryString(audit.safeInputSummary, 'reasonCodes');
      items.push(
        entry({
          id: `audit:${audit.id}`,
          at: audit.createdAt.toISOString(),
          kind,
          actor: byOperator
            ? 'operator'
            : summaryString(audit.safeInputSummary, 'actor') === 'AGENT'
              ? 'assistant'
              : 'system',
          actorName: byOperator ? operatorName(audit.actorId) : null,
          from:
            kind === 'stage.moved'
              ? stageOf(summaryString(audit.safeInputSummary, 'from'))
              : null,
          to:
            kind === 'stage.moved'
              ? stageOf(summaryString(audit.safeInputSummary, 'to'))
              : null,
          reasonCode: reason ? (reason.split(',')[0] ?? null) : null,
        }),
      );
    }
    if (!createdByOperator)
      items.push(
        entry({
          id: `lead:${lead.id}`,
          at: lead.createdAt.toISOString(),
          kind: 'lead.created',
          actor: 'assistant',
        }),
      );
    for (const task of tasks) {
      const by = task.createdByOperatorId;
      items.push(
        entry({
          id: `task:${task.id}`,
          at: task.createdAt.toISOString(),
          kind: 'task.created',
          actor: by ? 'operator' : 'system',
          actorName: operatorName(by),
          text: preview(task.title),
        }),
      );
      if (task.doneAt)
        items.push(
          entry({
            id: `task-done:${task.id}`,
            at: task.doneAt.toISOString(),
            kind: 'task.done',
            actor: 'operator',
            text: preview(task.title),
          }),
        );
    }
    for (const note of notes)
      items.push(
        entry({
          id: `note:${note.id}`,
          at: note.createdAt.toISOString(),
          kind: 'note',
          actor: 'operator',
          actorName: operatorName(note.operatorId),
          text: preview(note.text),
        }),
      );
    for (const handover of handovers) {
      items.push(
        entry({
          id: `handover:${handover.id}`,
          at: handover.openedAt.toISOString(),
          kind: 'handover.opened',
          actor: 'assistant',
          reasonCode: handover.reasonCode,
        }),
      );
      if (handover.takenAt)
        items.push(
          entry({
            id: `handover-taken:${handover.id}`,
            at: handover.takenAt.toISOString(),
            kind: 'handover.taken',
            actor: 'operator',
            actorName: operatorName(handover.assignedOperatorId),
          }),
        );
      if (handover.resolvedAt)
        items.push(
          entry({
            id: `handover-resolved:${handover.id}`,
            at: handover.resolvedAt.toISOString(),
            kind: 'handover.resolved',
            actor: 'operator',
            actorName: operatorName(handover.assignedOperatorId),
          }),
        );
    }
    for (const message of messages)
      items.push(
        entry({
          id: `message:${message.id}`,
          at: message.createdAt.toISOString(),
          kind: 'message',
          actor: MESSAGE_ACTOR[message.authorType] ?? 'system',
          text: preview(message.text) || null,
        }),
      );
    return { items: sortTimeline(items) };
  }
}
