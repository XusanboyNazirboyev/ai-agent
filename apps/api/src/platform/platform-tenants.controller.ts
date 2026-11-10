import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { TenantAccessService } from '../access/tenant-access.service.js';
import { INITIAL_LOCALE_PACKS } from '../locales/locale-packs.js';
import { DOMAIN_PACKS } from '../packs/registry.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  InviteError,
  OperatorInviteService,
  type CreatedInvite,
  type PendingInvite,
} from '../team/operator-invite.service.js';
import { TEAM_ROLES, type TeamRole } from '../team/team-rules.js';
import { inviteHttpError } from '../webinbox/team.controller.js';
import { recordPlatformAudit } from './platform-audit.js';
import {
  conflict,
  isUniqueViolation,
  notFound,
  parseBody,
} from './platform-http.js';
import {
  PlatformSessionGuard,
  type PlatformRequest,
} from './platform-session.guard.js';
import { addDays, monthStartUtc, nanoToUsd } from './subscription-math.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/u;
const OPEN = ['TRIAL', 'ACTIVE', 'PAST_DUE'] as const;
const Role = z.enum(TEAM_ROLES as [TeamRole, ...TeamRole[]]);

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const CreateTenant = z.object({
  slug: z.string().regex(SLUG),
  name: z.string().trim().min(1).max(200),
  pack: z.string().refine((value) => DOMAIN_PACKS.has(value)),
  defaultLocale: z
    .string()
    .refine((value) =>
      INITIAL_LOCALE_PACKS.some((locale) => (locale.id as string) === value),
    ),
  timezone: z.string().max(64).refine(isTimeZone),
  ownerEmail: z.string().min(3).max(254),
  /** Optional: start a subscription right away. */
  planId: z.uuid().optional(),
  trialDays: z.number().int().min(1).max(365).optional(),
});

const PatchTenant = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine((body) => body.name !== undefined || body.status !== undefined);

const InviteBody = z.object({
  email: z.string().min(3).max(254),
  role: Role,
});

const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
});

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  createdAt: Date;
  subscription: {
    id: string;
    status: string;
    planId: string;
    planCode: string;
    planName: string;
    currentPeriodEnd: Date;
    graceUntil: Date | null;
  } | null;
  usage: {
    conversations: number;
    inboundMessages: number;
    llmCostUsd: number;
  };
}

/**
 * Tenants as the platform sees them (ADR 047 §4). The only module that
 * reads across tenants (rule 3 exception); nothing outside `src/platform`
 * imports it.
 */
@Controller('api/v1/platform/tenants')
@UseGuards(PlatformSessionGuard)
export class PlatformTenantsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invites: OperatorInviteService,
    private readonly access: TenantAccessService,
  ) {}

  @Get()
  async list(@Query() query: unknown): Promise<{ tenants: TenantRow[] }> {
    const filter = parseBody(ListQuery, query ?? {});
    const tenants = await this.prisma.tenant.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.q
          ? {
              OR: [
                { name: { contains: filter.q, mode: 'insensitive' } },
                { slug: { contains: filter.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        createdAt: true,
      },
    });
    const ids = tenants.map((tenant) => tenant.id);
    const usage = await this.usage(ids, new Date());
    const subscriptions = await this.currentSubscriptions(ids);
    return {
      tenants: tenants.map((tenant) => ({
        ...tenant,
        subscription: subscriptions.get(tenant.id) ?? null,
        usage: usage.get(tenant.id) ?? {
          conversations: 0,
          inboundMessages: 0,
          llmCostUsd: 0,
        },
      })),
    };
  }

  /** What the "new customer" form may choose: Domain Packs and locales. */
  @Get('options')
  options(): { packs: string[]; locales: string[] } {
    return {
      packs: [...DOMAIN_PACKS.keys()],
      locales: INITIAL_LOCALE_PACKS.map((locale) => locale.id as string),
    };
  }

  @Get(':id')
  async detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<unknown> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        defaultLocale: true,
        timezone: true,
        packKey: true,
        packVersion: true,
        createdAt: true,
      },
    });
    if (!tenant) throw notFound();
    const now = new Date();
    const [usage, subscriptions, access, operators, channels] =
      await Promise.all([
        this.usage([id], now),
        this.currentSubscriptions([id]),
        this.access.check(id, now),
        this.prisma.operator.findMany({
          where: { tenantId: id },
          orderBy: { createdAt: 'asc' },
          take: 200,
          select: {
            id: true,
            displayName: true,
            role: true,
            isActive: true,
            createdAt: true,
          },
        }),
        this.prisma.channelAccount.findMany({
          where: { tenantId: id },
          select: { id: true, channelType: true, status: true },
          take: 50,
        }),
      ]);
    return {
      tenant,
      access: {
        state: access.state,
        periodEnd: access.periodEnd,
        graceUntil: access.graceUntil,
      },
      subscription: subscriptions.get(id) ?? null,
      usage: usage.get(id) ?? {
        conversations: 0,
        inboundMessages: 0,
        llmCostUsd: 0,
      },
      operators,
      channels,
      invites: await this.invites.listPending(id, now),
    };
  }

  @Post()
  async create(
    @Req() request: PlatformRequest,
    @Body() body: unknown,
  ): Promise<{
    tenant: { id: string; slug: string; name: string };
    invite: CreatedInvite & { path: string };
  }> {
    const input = parseBody(CreateTenant, body);
    const actor = request.platform!.adminId;
    const pack = DOMAIN_PACKS.get(input.pack)!;
    const now = new Date();
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        if (await tx.tenant.findUnique({ where: { slug: input.slug } }))
          throw conflict('SLUG_TAKEN');
        const plan = input.planId
          ? await tx.subscriptionPlan.findFirst({
              where: { id: input.planId, isActive: true },
            })
          : null;
        if (input.planId && !plan) throw notFound();
        const tenant = await tx.tenant.create({
          data: {
            slug: input.slug,
            name: input.name,
            defaultLocale: input.defaultLocale,
            supportedLocales: INITIAL_LOCALE_PACKS.map((locale) => locale.id),
            timezone: input.timezone,
            packKey: pack.key,
            packVersion: pack.version,
            config: { billing: { required: true } },
          },
        });
        if (plan) {
          const trial = input.trialDays !== undefined;
          const subscription = await tx.tenantSubscription.create({
            data: {
              tenantId: tenant.id,
              planId: plan.id,
              status: trial ? 'TRIAL' : 'ACTIVE',
              currentPeriodStart: now,
              currentPeriodEnd: addDays(
                now,
                input.trialDays ?? plan.periodDays,
              ),
            },
          });
          await recordPlatformAudit(tx, {
            actorAdminId: actor,
            action: 'subscription.started',
            tenantId: tenant.id,
            entityType: 'tenant_subscription',
            entityId: subscription.id,
            summary: { planCode: plan.code, status: subscription.status },
          });
        }
        const invite = await this.invites.create(
          {
            tenantId: tenant.id,
            email: input.ownerEmail,
            role: 'OWNER',
            createdByPlatformAdminId: actor,
          },
          now,
          tx,
        );
        await recordPlatformAudit(tx, {
          actorAdminId: actor,
          action: 'tenant.created',
          tenantId: tenant.id,
          entityType: 'tenant',
          entityId: tenant.id,
          summary: { slug: tenant.slug, pack: input.pack, inviteId: invite.id },
        });
        return {
          tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
          invite,
        };
      });
      return {
        tenant: result.tenant,
        invite: { ...result.invite, path: `/invite/${result.invite.token}` },
      };
    } catch (error) {
      if (error instanceof InviteError) throw inviteHttpError(error);
      if (isUniqueViolation(error)) throw conflict('SLUG_TAKEN');
      throw error;
    }
  }

  @Patch(':id')
  async update(
    @Req() request: PlatformRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<{ id: string; name: string; status: string }> {
    const input = parseBody(PatchTenant, body);
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const before = await tx.tenant.findUnique({
        where: { id },
        select: { name: true, status: true },
      });
      if (!before) return undefined;
      const tenant = await tx.tenant.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
        select: { id: true, name: true, status: true },
      });
      // A suspended tenant is signed out everywhere, not only at next login.
      if (tenant.status !== 'ACTIVE' && before.status === 'ACTIVE')
        await tx.operatorSession.updateMany({
          where: { tenantId: id, revokedAt: null },
          data: { revokedAt: now },
        });
      await recordPlatformAudit(tx, {
        actorAdminId: request.platform!.adminId,
        action: 'tenant.updated',
        tenantId: id,
        entityType: 'tenant',
        entityId: id,
        summary: {
          reason: input.reason,
          fromStatus: before.status,
          toStatus: tenant.status,
          renamed: input.name !== undefined && input.name !== before.name,
        },
      });
      return tenant;
    });
    if (!updated) throw notFound();
    this.access.invalidate(id);
    return updated;
  }

  @Get(':id/invites')
  async listInvites(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ invites: PendingInvite[] }> {
    await this.requireTenant(id);
    return { invites: await this.invites.listPending(id) };
  }

  @Post(':id/invites')
  async invite(
    @Req() request: PlatformRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<CreatedInvite & { path: string }> {
    const input = parseBody(InviteBody, body);
    await this.requireTenant(id);
    let created: CreatedInvite;
    try {
      created = await this.invites.create({
        tenantId: id,
        email: input.email,
        role: input.role,
        createdByPlatformAdminId: request.platform!.adminId,
      });
    } catch (error) {
      throw inviteHttpError(error);
    }
    await recordPlatformAudit(this.prisma, {
      actorAdminId: request.platform!.adminId,
      action: 'invite.created',
      tenantId: id,
      entityType: 'operator_invite',
      entityId: created.id,
      summary: { role: created.role },
    });
    return { ...created, path: `/invite/${created.token}` };
  }

  @Delete(':id/invites/:inviteId')
  @HttpCode(204)
  async revokeInvite(
    @Req() request: PlatformRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('inviteId', new ParseUUIDPipe()) inviteId: string,
  ): Promise<void> {
    if (!(await this.invites.revoke(id, inviteId))) throw notFound();
    await recordPlatformAudit(this.prisma, {
      actorAdminId: request.platform!.adminId,
      action: 'invite.revoked',
      tenantId: id,
      entityType: 'operator_invite',
      entityId: inviteId,
    });
  }

  private async requireTenant(id: string): Promise<void> {
    const found = await this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw notFound();
  }

  private async currentSubscriptions(
    ids: readonly string[],
  ): Promise<Map<string, NonNullable<TenantRow['subscription']>>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.tenantSubscription.findMany({
      where: { tenantId: { in: [...ids] } },
      orderBy: { createdAt: 'desc' },
      include: { plan: { select: { code: true, name: true } } },
    });
    const result = new Map<string, NonNullable<TenantRow['subscription']>>();
    // The open row wins; otherwise the newest one.
    const ordered = [
      ...rows.filter((row) => (OPEN as readonly string[]).includes(row.status)),
      ...rows,
    ];
    for (const row of ordered)
      if (!result.has(row.tenantId))
        result.set(row.tenantId, {
          id: row.id,
          status: row.status,
          planId: row.planId,
          planCode: row.plan.code,
          planName: row.plan.name,
          currentPeriodEnd: row.currentPeriodEnd,
          graceUntil: row.graceUntil,
        });
    return result;
  }

  private async usage(
    ids: readonly string[],
    now: Date,
  ): Promise<Map<string, TenantRow['usage']>> {
    const result = new Map<string, TenantRow['usage']>();
    if (ids.length === 0) return result;
    const since = monthStartUtc(now);
    const tenantIds = [...ids];
    const [conversations, messages, costs] = await Promise.all([
      this.prisma.conversation.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: tenantIds }, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.message.groupBy({
        by: ['tenantId'],
        where: {
          tenantId: { in: tenantIds },
          direction: 'INBOUND',
          createdAt: { gte: since },
        },
        _count: { _all: true },
      }),
      this.prisma.llmUsageRecord.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: tenantIds }, createdAt: { gte: since } },
        _sum: { costNano: true },
      }),
    ]);
    const entry = (id: string): TenantRow['usage'] => {
      let value = result.get(id);
      if (!value) {
        value = { conversations: 0, inboundMessages: 0, llmCostUsd: 0 };
        result.set(id, value);
      }
      return value;
    };
    for (const row of conversations)
      entry(row.tenantId).conversations = row._count._all;
    for (const row of messages)
      entry(row.tenantId).inboundMessages = row._count._all;
    for (const row of costs)
      entry(row.tenantId).llmCostUsd = nanoToUsd(row._sum.costNano);
    return result;
  }
}
