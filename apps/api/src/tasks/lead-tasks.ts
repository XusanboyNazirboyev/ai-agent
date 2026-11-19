import {
  Optional,
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
import {
  OPERATOR_ALERT_EVENT,
  type OperatorAlert,
} from '../observability/alerts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { ScheduledScan } from '../handover/handover-runtime.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { runWithTenant } from '../persistence/tenant-context.js';
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
  /** When the reminder fires if earlier than the due time; null = at due time. */
  remindAt: string | null;
  overdue: boolean;
}

/** Minutes before the due time a reminder may be set to (0 = at due time). */
export const REMIND_BEFORE_MINUTES = [0, 15, 60, 1440] as const;
const RemindBefore = z
  .union([z.literal(0), z.literal(15), z.literal(60), z.literal(1440)])
  .nullable()
  .optional();

function remindAtFor(
  dueAt: Date,
  before: number | null | undefined,
): Date | null {
  return before ? new Date(dueAt.getTime() - before * 60_000) : null;
}

export const TASK_STATUSES = ['overdue', 'today', 'upcoming', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const CreateBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    dueAt: z.iso.datetime({ offset: true }),
    assigneeId: z.uuid().nullable().optional(),
    remindBefore: RemindBefore,
  })
  .strict();
const PatchBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    dueAt: z.iso.datetime({ offset: true }).optional(),
    done: z.boolean().optional(),
    assigneeId: z.uuid().nullable().optional(),
    remindBefore: RemindBefore,
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0);
const MineQuery = z
  .object({ until: z.iso.datetime({ offset: true }).optional() })
  .strict();

const ListQuery = z
  .object({
    scope: z.enum(['mine', 'all']).default('mine'),
    status: z.enum(TASK_STATUSES).default('today'),
    assigneeId: z.uuid().optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const SELECT = {
  id: true,
  leadId: true,
  title: true,
  dueAt: true,
  doneAt: true,
  remindAt: true,
  assignee: { select: { id: true, displayName: true } },
} as const;

function view(
  row: {
    id: string;
    leadId: string;
    title: string;
    dueAt: Date;
    doneAt: Date | null;
    remindAt: Date | null;
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
    remindAt: row.remindAt?.toISOString() ?? null,
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

function encodeCursor(dueAt: Date, id: string): string {
  return Buffer.from(`${dueAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(raw: string): { dueAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(raw, 'base64url').toString().split('|');
  if (!iso || !id || !z.uuid().safeParse(id).success) return null;
  const dueAt = new Date(iso);
  return Number.isNaN(dueAt.getTime()) ? null : { dueAt, id };
}

/** Offset of `zone` from UTC at `instant`, in ms (0 when the zone is unknown). */
function zoneOffsetMs(instant: Date, zone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).formatToParts(instant);
    const n = (type: string): number =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    const asUtc = Date.UTC(
      n('year'),
      n('month') - 1,
      n('day'),
      n('hour'),
      n('minute'),
      n('second'),
    );
    return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
  } catch {
    return 0;
  }
}

/** Start and end (exclusive) of the local day containing `now` in `zone`. */
export function localDayBounds(
  now: Date,
  zone: string,
): { start: Date; end: Date } {
  const local = new Date(now.getTime() + zoneOffsetMs(now, zone));
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const at = (day: number): Date => {
    const guess = Date.UTC(y, m, day);
    // Re-measure the offset at the guessed instant (daylight saving shifts).
    const first = guess - zoneOffsetMs(new Date(guess), zone);
    return new Date(guess - zoneOffsetMs(new Date(first), zone));
  };
  return { start: at(d), end: at(d + 1) };
}

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
        remindAt: remindAtFor(
          new Date(parsed.data.dueAt),
          parsed.data.remindBefore,
        ),
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
    // A changed due time or reminder is announced again when it comes.
    const timing =
      parsed.data.dueAt !== undefined || parsed.data.remindBefore !== undefined;
    let timingData: {
      dueAt?: Date;
      remindAt?: Date | null;
      notifiedAt?: null;
    } = {};
    if (timing) {
      const current = await this.prisma.leadTask.findFirst({
        where: { tenantId: who.tenantId, id },
        select: { dueAt: true, remindAt: true },
      });
      if (!current) throw notFound();
      const dueAt =
        parsed.data.dueAt !== undefined
          ? new Date(parsed.data.dueAt)
          : current.dueAt;
      // Without a new reminder choice the old lead time is kept.
      const before =
        parsed.data.remindBefore !== undefined
          ? parsed.data.remindBefore
          : current.remindAt
            ? Math.round(
                (current.dueAt.getTime() - current.remindAt.getTime()) / 60_000,
              )
            : null;
      timingData = {
        dueAt,
        remindAt: remindAtFor(dueAt, before),
        notifiedAt: null,
      };
    }
    const data = {
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...timingData,
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

  /**
   * The Tasks page (ADR 068 amendment): tasks of the workspace by segment.
   * overdue = open and past due; today = open, due later today (tenant time
   * zone); upcoming = open, due after today; done = finished. The four
   * counts use the same scope and assignee. Tasks of archived leads are left out.
   */
  @Get('tasks')
  async listAll(
    @Req() request: InboxRequest,
    @Query() query: unknown,
  ): Promise<{
    items: Array<
      LeadTaskView & {
        contactName: string | null;
      }
    >;
    nextCursor: string | null;
    counts: Record<TaskStatus, number>;
  }> {
    const principal = request.principal!;
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw invalid();
    const { scope, status, assigneeId, limit } = parsed.data;
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: principal.tenantId },
      select: { timezone: true },
    });
    const now = new Date();
    const { end: endOfToday } = localDayBounds(now, tenant?.timezone ?? 'UTC');
    const base: Prisma.LeadTaskWhereInput = {
      tenantId: principal.tenantId,
      lead: { archivedAt: null },
      ...(scope === 'mine'
        ? { assigneeOperatorId: principal.operatorId }
        : assigneeId
          ? { assigneeOperatorId: assigneeId }
          : {}),
    };
    const segment = (kind: TaskStatus): Prisma.LeadTaskWhereInput => {
      switch (kind) {
        case 'overdue':
          return { doneAt: null, dueAt: { lt: now } };
        case 'today':
          return { doneAt: null, dueAt: { gte: now, lt: endOfToday } };
        case 'upcoming':
          return { doneAt: null, dueAt: { gte: endOfToday } };
        case 'done':
          return { doneAt: { not: null } };
      }
    };
    const desc = status === 'done';
    const sort = desc ? 'desc' : 'asc';
    let keyset: Prisma.LeadTaskWhereInput = {};
    if (parsed.data.cursor) {
      const cursor = decodeCursor(parsed.data.cursor);
      if (!cursor) throw invalid();
      const cmp = desc ? 'lt' : 'gt';
      keyset = {
        OR: [
          { dueAt: { [cmp]: cursor.dueAt } },
          { dueAt: cursor.dueAt, id: { [cmp]: cursor.id } },
        ],
      };
    }
    const rows = await this.prisma.leadTask.findMany({
      where: { AND: [base, segment(status), keyset] },
      orderBy: [{ dueAt: sort }, { id: sort }],
      take: limit + 1,
      select: {
        ...SELECT,
        lead: { select: { contact: { select: { name: true } } } },
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const countOf = (kind: TaskStatus): Promise<number> =>
      this.prisma.leadTask.count({ where: { AND: [base, segment(kind)] } });
    const [overdue, today, upcoming, done] = await Promise.all(
      TASK_STATUSES.map(countOf),
    );
    return {
      items: page.map((row) => ({
        ...view(row, now),
        contactName: row.lead.contact.name,
      })),
      nextCursor:
        rows.length > limit && last ? encodeCursor(last.dueAt, last.id) : null,
      counts: { overdue, today, upcoming, done },
    };
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

  /** RLS plan S7: finds due work of every tenant; the work runs per tenant. */
  private readonly crossTenant: PrismaClient;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    // Optional only so specs can build it by hand; Nest always provides it.
    @Optional() privileged?: PrivilegedDatabase,
  ) {
    this.crossTenant = privileged?.db ?? prisma;
  }

  async scanDue(now: Date, limit = 100): Promise<number> {
    // Announced at the reminder time when one is set, else at the due time.
    const due = await this.crossTenant.leadTask.findMany({
      where: {
        doneAt: null,
        notifiedAt: null,
        OR: [
          { remindAt: { lte: now } },
          { remindAt: null, dueAt: { lte: now } },
        ],
      },
      orderBy: { dueAt: 'asc' },
      take: limit,
      select: {
        id: true,
        tenantId: true,
        title: true,
        lead: { select: { conversationId: true } },
      },
    });
    let announced = 0;
    let telegramQueued = 0;
    let telegramSkipped = 0;
    for (const task of due) {
      const result = await runWithTenant(task.tenantId, () =>
        this.prisma.$transaction(
          async (tx): Promise<'none' | 'sent' | 'skipped'> => {
            const claimed = await tx.leadTask.updateMany({
              where: {
                id: task.id,
                tenantId: task.tenantId,
                notifiedAt: null,
                doneAt: null,
              },
              data: { notifiedAt: now },
            });
            if (claimed.count !== 1) return 'none';
            await tx.inboxEvent.create({
              data: {
                tenantId: task.tenantId,
                type: 'task.due',
                conversationId: task.lead.conversationId,
                taskTitle: task.title,
              },
            });
            // The tenant's Telegram operator group: one message per claim (the
            // key carries the claim time, so a re-armed task is sent again and
            // a retried or parallel scan is not). No group: skipped.
            const group = await tx.channelAccount.count({
              where: {
                tenantId: task.tenantId,
                operatorChatId: { not: null },
                status: 'ACTIVE',
              },
            });
            if (group === 0) return 'skipped';
            const alert: OperatorAlert = {
              kind: 'TASK_DUE',
              taskId: task.id,
            };
            await tx.outboxEvent.createMany({
              data: [
                {
                  tenantId: task.tenantId,
                  type: OPERATOR_ALERT_EVENT,
                  aggregateType: 'tenant',
                  aggregateId: task.tenantId,
                  idempotencyKey: `alert:task-due:${task.id}:${now.toISOString()}`,
                  payload: alert satisfies Prisma.InputJsonObject,
                },
              ],
              skipDuplicates: true,
            });
            return 'sent';
          },
        ),
      );
      if (result === 'none') continue;
      announced += 1;
      if (result === 'sent') telegramQueued += 1;
      else telegramSkipped += 1;
    }
    if (announced > 0)
      this.logger.log(
        JSON.stringify({
          event: 'tasks.announced',
          count: announced,
          telegramQueued,
          telegramSkippedNoGroup: telegramSkipped,
        }),
      );
    return announced;
  }
}
