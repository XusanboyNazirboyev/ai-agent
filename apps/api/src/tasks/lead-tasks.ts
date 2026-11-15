import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { ScheduledScan } from '../handover/handover-runtime.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { SessionGuard, type InboxRequest } from '../webinbox/session.guard.js';

/** At most this many open tasks per lead (a guard, not a product limit). */
export const MAX_OPEN_TASKS_PER_LEAD = 50;

export interface LeadTaskView {
  id: string;
  leadId: string;
  title: string;
  dueAt: string;
  assignee: { id: string; displayName: string } | null;
  doneAt: string | null;
  overdue: boolean;
}

const CreateBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    dueAt: z.iso.datetime({ offset: true }),
    assigneeId: z.uuid().nullable().optional(),
  })
  .strict();
const PatchBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    dueAt: z.iso.datetime({ offset: true }).optional(),
    done: z.boolean().optional(),
    assigneeId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0);
const MineQuery = z
  .object({ until: z.iso.datetime({ offset: true }).optional() })
  .strict();

const SELECT = {
  id: true,
  leadId: true,
  title: true,
  dueAt: true,
  doneAt: true,
  assignee: { select: { id: true, displayName: true } },
} as const;

function view(
  row: {
    id: string;
    leadId: string;
    title: string;
    dueAt: Date;
    doneAt: Date | null;
    assignee: { id: string; displayName: string } | null;
  },
  now: Date,
): LeadTaskView {
  return {
    id: row.id,
    leadId: row.leadId,
    title: row.title,
    dueAt: row.dueAt.toISOString(),
    assignee: row.assignee,
    doneAt: row.doneAt?.toISOString() ?? null,
    overdue: row.doneAt === null && row.dueAt.getTime() < now.getTime(),
  };
}

const invalid = (): BadRequestException =>
  new BadRequestException({
    code: 'INVALID_BODY',
    message: 'Invalid body',
    i18nKey: 'errors.invalidBody',
  });
const notFound = (): NotFoundException =>
  new NotFoundException({
    code: 'NOT_FOUND',
    message: 'Not found',
    i18nKey: 'errors.notFound',
  });

/**
 * Tasks on a lead (roadmap P1.6, ADR 068): "call back tomorrow at 10". Any
 * signed-in person reads them; owners, admins and operators add, change,
 * finish and delete them (a viewer only reads). Tenant from the session only.
 */
@Controller('api/v1')
@UseGuards(SessionGuard)
export class LeadTasksController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private writer(request: InboxRequest): {
    tenantId: string;
    operatorId: string;
  } {
    const principal = request.principal!;
    if (principal.role === 'VIEWER')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    return { tenantId: principal.tenantId, operatorId: principal.operatorId };
  }

  private async assignee(
    tenantId: string,
    id: string | null | undefined,
  ): Promise<string | null | undefined> {
    if (id === undefined || id === null) return id;
    const found = await this.prisma.operator.findFirst({
      where: { tenantId, id, isActive: true },
      select: { id: true },
    });
    if (!found) throw invalid();
    return found.id;
  }

  @Get('leads/:leadId/tasks')
  async list(
    @Req() request: InboxRequest,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
  ): Promise<{ items: LeadTaskView[] }> {
    const tenantId = request.principal!.tenantId;
    const lead = await this.prisma.lead.findFirst({
      where: { tenantId, id: leadId },
      select: { id: true },
    });
    if (!lead) throw notFound();
    const rows = await this.prisma.leadTask.findMany({
      where: { tenantId, leadId },
      orderBy: [{ doneAt: { sort: 'asc', nulls: 'first' } }, { dueAt: 'asc' }],
      take: 200,
      select: SELECT,
    });
    const now = new Date();
    return { items: rows.map((row) => view(row, now)) };
  }

  @Post('leads/:leadId/tasks')
  async create(
    @Req() request: InboxRequest,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: unknown,
  ): Promise<LeadTaskView> {
    const who = this.writer(request);
    const parsed = CreateBody.safeParse(body);
    if (!parsed.success) throw invalid();
    const lead = await this.prisma.lead.findFirst({
      where: { tenantId: who.tenantId, id: leadId },
      select: { id: true },
    });
    if (!lead) throw notFound();
    const open = await this.prisma.leadTask.count({
      where: { tenantId: who.tenantId, leadId, doneAt: null },
    });
    if (open >= MAX_OPEN_TASKS_PER_LEAD) throw invalid();
    // The person adding it is the default assignee.
    const assigneeId =
      (await this.assignee(who.tenantId, parsed.data.assigneeId)) ??
      (parsed.data.assigneeId === null ? null : who.operatorId);
    const row = await this.prisma.leadTask.create({
      data: {
        tenantId: who.tenantId,
        leadId,
        title: parsed.data.title,
        dueAt: new Date(parsed.data.dueAt),
        assigneeOperatorId: assigneeId,
        createdByOperatorId: who.operatorId,
      },
      select: SELECT,
    });
    return view(row, new Date());
  }

  @Patch('tasks/:id')
  async update(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<LeadTaskView> {
    const who = this.writer(request);
    const parsed = PatchBody.safeParse(body);
    if (!parsed.success) throw invalid();
    const assigneeId = await this.assignee(
      who.tenantId,
      parsed.data.assigneeId,
    );
    const data = {
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      // A new due time is announced again when it comes.
      ...(parsed.data.dueAt !== undefined
        ? { dueAt: new Date(parsed.data.dueAt), notifiedAt: null }
        : {}),
      ...(parsed.data.done !== undefined
        ? { doneAt: parsed.data.done ? new Date() : null }
        : {}),
      ...(assigneeId !== undefined ? { assigneeOperatorId: assigneeId } : {}),
    };
    const changed = await this.prisma.leadTask.updateMany({
      where: { tenantId: who.tenantId, id },
      data,
    });
    if (changed.count === 0) throw notFound();
    const row = await this.prisma.leadTask.findFirstOrThrow({
      where: { tenantId: who.tenantId, id },
      select: SELECT,
    });
    return view(row, new Date());
  }

  @Delete('tasks/:id')
  @HttpCode(204)
  async remove(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const who = this.writer(request);
    const removed = await this.prisma.leadTask.deleteMany({
      where: { tenantId: who.tenantId, id },
    });
    if (removed.count === 0) throw notFound();
  }

  /** The signed-in person's open tasks due before `until` (default: end of time). */
  @Get('tasks/mine')
  async mine(
    @Req() request: InboxRequest,
    @Query() query: unknown,
  ): Promise<{ items: Array<LeadTaskView & { contactName: string | null }> }> {
    const principal = request.principal!;
    const parsed = MineQuery.safeParse(query);
    if (!parsed.success) throw invalid();
    const rows = await this.prisma.leadTask.findMany({
      where: {
        tenantId: principal.tenantId,
        assigneeOperatorId: principal.operatorId,
        doneAt: null,
        ...(parsed.data.until
          ? { dueAt: { lte: new Date(parsed.data.until) } }
          : {}),
      },
      orderBy: { dueAt: 'asc' },
      take: 50,
      select: {
        ...SELECT,
        lead: { select: { contact: { select: { name: true } } } },
      },
    });
    const now = new Date();
    return {
      items: rows.map((row) => ({
        ...view(row, now),
        contactName: row.lead.contact.name,
      })),
    };
  }
}

/**
 * The reminder scan: a task whose time came is announced once, as an inbox
 * event `task.due` on the lead's conversation (the web shows it and plays the
 * alert). Claimed row by row, so two API processes never announce it twice.
 */
@Injectable()
export class LeadTaskReminders implements ScheduledScan {
  private readonly logger = new Logger(LeadTaskReminders.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async scanDue(now: Date, limit = 100): Promise<number> {
    const due = await this.prisma.leadTask.findMany({
      where: { doneAt: null, notifiedAt: null, dueAt: { lte: now } },
      orderBy: { dueAt: 'asc' },
      take: limit,
      select: {
        id: true,
        tenantId: true,
        lead: { select: { conversationId: true } },
      },
    });
    let announced = 0;
    for (const task of due) {
      const claimed = await this.prisma.leadTask.updateMany({
        where: {
          id: task.id,
          tenantId: task.tenantId,
          notifiedAt: null,
          doneAt: null,
        },
        data: { notifiedAt: now },
      });
      if (claimed.count !== 1) continue;
      await this.prisma.inboxEvent.create({
        data: {
          tenantId: task.tenantId,
          type: 'task.due',
          conversationId: task.lead.conversationId,
        },
      });
      announced += 1;
    }
    if (announced > 0)
      this.logger.log(
        JSON.stringify({ event: 'tasks.announced', count: announced }),
      );
    return announced;
  }
}
