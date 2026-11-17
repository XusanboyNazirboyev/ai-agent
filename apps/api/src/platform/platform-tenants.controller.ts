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
import { MANUAL_CHANNEL_TYPE } from '../leads/manual-lead-rules.js';
import { z } from 'zod';
import { TenantAccessService } from '../access/tenant-access.service.js';
import { INITIAL_LOCALE_PACKS } from '../locales/locale-packs.js';
import { DOMAIN_PACKS } from '../packs/registry.js';
import { TelegramManagement } from '../channels/telegram/telegram-management.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { runWithTenant } from '../persistence/tenant-context.js';
import { ChannelSecretStore } from '../secrets/channel-secret-store.js';
import {
  InviteError,
  OperatorInviteService,
  type CreatedInvite,
  type PendingInvite,
} from '../team/operator-invite.service.js';
import { TEAM_ROLES, type TeamRole } from '../team/team-rules.js';
import { PasswordResetService } from '../team/password-reset.service.js';
import {
  inviteHttpError,
  passwordResetHttpError,
} from '../webinbox/team.controller.js';
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
import { eraseTenantData } from './tenant-erasure.js';

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

const Locale = z
  .string()
  .refine((value) =>
    INITIAL_LOCALE_PACKS.some((locale) => (locale.id as string) === value),
  );

const PatchTenant = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
    defaultLocale: Locale.optional(),
    timezone: z.string().max(64).refine(isTimeZone).optional(),
    pack: z
      .string()
      .refine((value) => DOMAIN_PACKS.has(value))
      .optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.status !== undefined ||
      body.defaultLocale !== undefined ||
      body.timezone !== undefined ||
      body.pack !== undefined,
  );

/** Deleting asks for the slug typed again and a reason (ADR 047 amendment). */
const DeleteTenant = z.object({
  confirmSlug: z.string().trim().max(80),
  reason: z.string().trim().min(3).max(500),
});

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
  defaultLocale: string;
  timezone: string;
  packKey: string;
  packVersion: string;
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
  /** RLS plan S5b: the console reads across tenants on the privileged connection. */
  private readonly prisma: PrismaClient;

  constructor(
    privileged: PrivilegedDatabase,
    private readonly invites: OperatorInviteService,
    private readonly access: TenantAccessService,
    private readonly secrets: ChannelSecretStore,
    private readonly telegram: TelegramManagement,
    private readonly resets: PasswordResetService,
  ) {
    this.prisma = privileged.db;
  }

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
        defaultLocale: true,
        timezone: true,
        packKey: true,
        packVersion: true,
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
          where: { tenantId: id, channelType: { not: MANUAL_CHANNEL_TYPE } },
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
    const pack =
      input.pack !== undefined ? DOMAIN_PACKS.get(input.pack)! : undefined;
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const before = await tx.tenant.findUnique({
        where: { id },
        select: {
          name: true,
          status: true,
          defaultLocale: true,
          supportedLocales: true,
          timezone: true,
          packKey: true,
          packVersion: true,
        },
      });
      if (!before) return undefined;
      const tenant = await tx.tenant.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.defaultLocale !== undefined
            ? {
                defaultLocale: input.defaultLocale,
                ...(before.supportedLocales.includes(input.defaultLocale)
                  ? {}
                  : {
                      supportedLocales: [
                        ...before.supportedLocales,
                        input.defaultLocale,
                      ],
                    }),
              }
            : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(pack ? { packKey: pack.key, packVersion: pack.version } : {}),
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
          ...(input.defaultLocale !== undefined &&
          input.defaultLocale !== before.defaultLocale
            ? {
                fromLocale: before.defaultLocale,
                toLocale: input.defaultLocale,
              }
            : {}),
          ...(input.timezone !== undefined && input.timezone !== before.timezone
            ? { fromTimezone: before.timezone, toTimezone: input.timezone }
            : {}),
          ...(pack &&
          `${pack.key}@${pack.version}` !==
            `${before.packKey}@${before.packVersion}`
            ? {
                fromPack: `${before.packKey}@${before.packVersion}`,
                toPack: `${pack.key}@${pack.version}`,
              }
            : {}),
        },
      });
      return tenant;
    });
    if (!updated) throw notFound();
    this.access.invalidate(id);
    return updated;
  }

  /**
   * Deletes an ARCHIVED tenant and everything it owns (ADR 047 amendment
   * 2026-11-17). The caller types the slug again and gives a reason; the
   * platform audit log keeps who, when, why and how much. Telegram bots are
   * told to stop calling first, best effort: a bot that cannot be reached is
   * reported, not a reason to keep the data.
   */
  @Delete(':id')
  async remove(
    @Req() request: PlatformRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<{
    deleted: true;
    tables: number;
    rows: number;
    telegram: { removed: number; failed: number };
  }> {
    const input = parseBody(DeleteTenant, body);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: { slug: true, status: true },
    });
    if (!tenant) throw notFound();
    if (tenant.status !== 'ARCHIVED') throw conflict('TENANT_NOT_ARCHIVED');
    if (input.confirmSlug !== tenant.slug)
      throw conflict('CONFIRMATION_MISMATCH');
    const telegram = await this.releaseTelegramBots(id);
    const erased = await this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ status: string }[]>`
          SELECT status::text AS status FROM tenants WHERE id = ${id}::uuid FOR UPDATE`;
        if (locked[0]?.status !== 'ARCHIVED') return undefined;
        const result = await eraseTenantData(tx, id);
        await tx.tenant.delete({ where: { id } });
        await recordPlatformAudit(tx, {
          actorAdminId: request.platform!.adminId,
          action: 'tenant.deleted',
          tenantId: null,
          entityType: 'tenant',
          entityId: id,
          summary: {
            reason: input.reason,
            slug: tenant.slug,
            tables: result.tables,
            rows: result.rows,
            telegramRemoved: telegram.removed,
            telegramFailed: telegram.failed,
          },
        });
        return result;
      },
      { maxWait: 10_000, timeout: 120_000 },
    );
    if (!erased) throw conflict('TENANT_NOT_ARCHIVED');
    this.access.invalidate(id);
    return { deleted: true, ...erased, telegram };
  }

  /** Best effort: the deleted tenant's Telegram bots stop calling this server. */
  private async releaseTelegramBots(
    tenantId: string,
  ): Promise<{ removed: number; failed: number }> {
    const accounts = await this.prisma.channelAccount.findMany({
      where: { tenantId, channelType: 'telegram' },
      select: { id: true },
    });
    let removed = 0;
    let failed = 0;
    for (const account of accounts) {
      try {
        if (!this.secrets.configured) throw new Error('secrets not configured');
        const token = await runWithTenant(tenantId, () =>
          this.secrets.get(
            { tenantId, channelAccountId: account.id },
            'bot_token',
          ),
        );
        if (!token) continue;
        await this.telegram.deleteWebhook(token);
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    return { removed, failed };
  }

  /**
   * A one-time password reset link for one of the tenant's people (ADR 047
   * amendment 2026-11-17), sent by hand like an invite. 24 hours, one use.
   */
  @Post(':id/operators/:operatorId/password-reset')
  async passwordReset(
    @Req() request: PlatformRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('operatorId', new ParseUUIDPipe()) operatorId: string,
  ): Promise<{ path: string; expiresAt: Date; email: string }> {
    let issued;
    try {
      issued = await this.prisma.$transaction(async (tx) => {
        const created = await this.resets.issue(
          {
            tenantId: id,
            operatorId,
            createdByPlatformAdminId: request.platform!.adminId,
          },
          tx,
        );
        await recordPlatformAudit(tx, {
          actorAdminId: request.platform!.adminId,
          action: 'operator.password_reset_issued',
          tenantId: id,
          entityType: 'operator',
          entityId: operatorId,
          summary: { expiresAt: created.expiresAt.toISOString() },
        });
        return created;
      });
    } catch (error) {
      throw passwordResetHttpError(error);
    }
    return {
      path: `/reset/${issued.token}`,
      expiresAt: issued.expiresAt,
      email: issued.email,
    };
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
