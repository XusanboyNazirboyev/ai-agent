import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../persistence/prisma.service.js';
import { parseBody } from './platform-http.js';
import { PlatformSessionGuard } from './platform-session.guard.js';

const AuditQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  tenantId: z.uuid().optional(),
});

/** Platform audit trail, newest first, paged (ADR 047 §4). */
@Controller('api/v1/platform/audit')
@UseGuards(PlatformSessionGuard)
export class PlatformAuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query() query: unknown): Promise<{
    page: number;
    pageSize: number;
    total: number;
    events: unknown[];
  }> {
    const input = parseBody(AuditQuery, query ?? {});
    const where = input.tenantId ? { tenantId: input.tenantId } : {};
    const [total, rows] = await Promise.all([
      this.prisma.platformAuditEvent.count({ where }),
      this.prisma.platformAuditEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        include: {
          actor: { select: { displayName: true } },
          tenant: { select: { slug: true, name: true } },
        },
      }),
    ]);
    return {
      page: input.page,
      pageSize: input.pageSize,
      total,
      events: rows.map((row) => ({
        id: row.id,
        action: row.action,
        actor: row.actor?.displayName ?? null,
        tenantId: row.tenantId,
        tenant: row.tenant
          ? { slug: row.tenant.slug, name: row.tenant.name }
          : null,
        entityType: row.entityType,
        entityId: row.entityId,
        summary: row.safeSummary,
        createdAt: row.createdAt,
      })),
    };
  }
}
