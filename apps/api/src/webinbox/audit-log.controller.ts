import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { forbidden, invalidQuery } from '../tags/tag-errors.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

/**
 * ADR 074: the tenant's audit log in the app, grouped the way an owner looks
 * for a change. Each category is a list of action prefixes; an action that
 * matches none is in "other".
 */
export const AUDIT_CATEGORIES = {
  conversations: [
    'operator.take_over',
    'operator.reply',
    'operator.add_note',
    'operator.close',
    'operator.return_to_bot',
    'conversation.',
    'action.',
    'system.',
  ],
  leads: [
    'lead.',
    'pipeline.',
    'export.leads',
    'operator.set_lead_',
    'operator.resend_lead_to_crm',
  ],
  contacts: ['contact.', 'person.', 'export.people'],
  channels: ['channel.', 'telegram.', 'tenant.inbound_blocked'],
  assistant: ['assistant.', 'knowledge.', 'catalog.', 'canned_response.'],
  crm: ['connector.', 'crm.', 'crm_template.'],
  fields: ['tag.', 'custom_field.'],
  team: ['team.', 'auth.', 'operator.password_reset'],
} as const satisfies Record<string, readonly string[]>;

export type AuditCategory = keyof typeof AUDIT_CATEGORIES | 'other';

const CATEGORY_KEYS = Object.keys(AUDIT_CATEGORIES) as Array<
  keyof typeof AUDIT_CATEGORIES
>;

/** The category of an action (the first whose prefix matches). */
export function auditCategory(action: string): AuditCategory {
  return (
    CATEGORY_KEYS.find((key) =>
      AUDIT_CATEGORIES[key].some((prefix) => action.startsWith(prefix)),
    ) ?? 'other'
  );
}

function prefixes(list: readonly string[]): Prisma.AuditEventWhereInput[] {
  return list.map((prefix) => ({ action: { startsWith: prefix } }));
}

/** Rows of a category; "other" is everything no category claims. */
export function categoryWhere(
  category: AuditCategory,
): Prisma.AuditEventWhereInput {
  if (category !== 'other') return { OR: prefixes(AUDIT_CATEGORIES[category]) };
  return {
    NOT: {
      OR: prefixes(CATEGORY_KEYS.flatMap((key) => AUDIT_CATEGORIES[key])),
    },
  };
}

const AuditQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  category: z.enum([...CATEGORY_KEYS, 'other']).optional(),
});

/** Who changed what, owners and admins only (spec 12A.5, ADR 074). */
const ALLOWED_ROLES = new Set(['OWNER', 'ADMIN']);

export interface AuditLogEvent {
  readonly id: string;
  readonly action: string;
  readonly category: AuditCategory;
  readonly actorType: string;
  /** The operator's display name; null for the system, a customer or a removed operator. */
  readonly actor: string | null;
  readonly entityType: string;
  readonly entityId: string;
  /** Ids and counts only: summaries never hold a name, phone or text. */
  readonly summary: Prisma.JsonValue;
  readonly createdAt: Date;
}

@Controller('api/v1/audit-events')
@UseGuards(SessionGuard)
export class AuditLogController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Req() request: InboxRequest,
    @Query() query: unknown,
  ): Promise<{
    page: number;
    pageSize: number;
    total: number;
    events: AuditLogEvent[];
  }> {
    const principal = request.principal!;
    if (!ALLOWED_ROLES.has(principal.role)) throw forbidden();
    const parsed = AuditQuery.safeParse(query ?? {});
    if (!parsed.success) throw invalidQuery();
    const input = parsed.data;
    const where: Prisma.AuditEventWhereInput = {
      tenantId: principal.tenantId,
      ...(input.category ? categoryWhere(input.category) : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.auditEvent.count({ where }),
      this.prisma.auditEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
    ]);
    const operatorIds = [
      ...new Set(
        rows
          .filter((row) => row.actorType === 'OPERATOR' && row.actorId)
          .map((row) => row.actorId!)
          .filter((id) => z.uuid().safeParse(id).success),
      ),
    ];
    const operators =
      operatorIds.length > 0
        ? await this.prisma.operator.findMany({
            where: { tenantId: principal.tenantId, id: { in: operatorIds } },
            select: { id: true, displayName: true },
          })
        : [];
    const names = new Map(operators.map((op) => [op.id, op.displayName]));
    return {
      page: input.page,
      pageSize: input.pageSize,
      total,
      events: rows.map((row) => ({
        id: row.id,
        action: row.action,
        category: auditCategory(row.action),
        actorType: row.actorType,
        actor:
          row.actorType === 'OPERATOR' && row.actorId
            ? (names.get(row.actorId) ?? null)
            : null,
        entityType: row.entityType,
        entityId: row.entityId,
        summary: row.safeInputSummary,
        createdAt: row.createdAt,
      })),
    };
  }
}
