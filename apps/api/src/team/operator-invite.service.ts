import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { TenantAccessService } from '../access/tenant-access.service.js';
import { hashPassword } from '../webinbox/password.js';
import {
  DEFAULT_SESSION_POLICY,
  SESSION_POLICY,
  type SessionPolicy,
} from '../webinbox/session.service.js';
import {
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  plausibleInviteToken,
} from './invite-token.js';
import { maxOperatorsOf, type TeamRole } from './team-rules.js';

export type InviteErrorCode =
  | 'INVITE_INVALID'
  | 'EMAIL_TAKEN'
  | 'SEATS_EXHAUSTED'
  | 'TENANT_SUSPENDED'
  | 'NOT_FOUND';

export class InviteError extends Error {
  constructor(readonly code: InviteErrorCode) {
    super(code);
    this.name = 'InviteError';
  }
}

export interface CreatedInvite {
  readonly id: string;
  readonly email: string;
  readonly role: TeamRole;
  readonly expiresAt: Date;
  /** Plain token: returned once, never stored or logged. */
  readonly token: string;
}

export interface PendingInvite {
  readonly id: string;
  readonly email: string;
  readonly role: TeamRole;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function normalizeEmail(input: string): string | undefined {
  const email = input.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : undefined;
}

type Db = Prisma.TransactionClient | PrismaService;

/**
 * Operator invites (ADR 047 §5), shared by the platform console (first
 * OWNER of a new tenant) and the tenant's Team page. Every query is scoped
 * by tenant; accepting creates the operator and its login in one
 * transaction under a per-tenant advisory lock (seat limit, races).
 */
@Injectable()
export class OperatorInviteService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(SESSION_POLICY)
    private readonly policy: SessionPolicy = DEFAULT_SESSION_POLICY,
    @Optional() private readonly access?: TenantAccessService,
  ) {}

  /** `maxOperators` of the tenant's open subscription, if any. */
  async seatLimit(
    tenantId: string,
    db: Db = this.prisma,
  ): Promise<number | undefined> {
    const open = await db.tenantSubscription.findFirst({
      where: { tenantId, status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] } },
      select: { plan: { select: { limits: true } } },
    });
    return open ? maxOperatorsOf(open.plan.limits) : undefined;
  }

  /** Active operators plus (optionally) open invites. */
  async seatsUsed(
    tenantId: string,
    now: Date,
    includeInvites: boolean,
    db: Db = this.prisma,
  ): Promise<number> {
    const operators = await db.operator.count({
      where: { tenantId, isActive: true },
    });
    if (!includeInvites) return operators;
    const invites = await db.operatorInvite.count({
      where: {
        tenantId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });
    return operators + invites;
  }

  async create(
    input: {
      readonly tenantId: string;
      readonly email: string;
      readonly role: TeamRole;
      readonly createdByPlatformAdminId?: string;
      readonly createdByOperatorId?: string;
    },
    now = new Date(),
    db?: Prisma.TransactionClient,
  ): Promise<CreatedInvite> {
    const run = async (
      tx: Prisma.TransactionClient,
    ): Promise<CreatedInvite> => {
      await lockTenantTeam(tx, input.tenantId);
      const email = normalizeEmail(input.email);
      if (!email) throw new InviteError('INVITE_INVALID');
      if (await tx.operatorCredential.findUnique({ where: { email } }))
        throw new InviteError('EMAIL_TAKEN');
      // A new invite replaces any open one for the same address.
      await tx.operatorInvite.updateMany({
        where: {
          tenantId: input.tenantId,
          email,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      const limit = await this.seatLimit(input.tenantId, tx);
      if (
        limit !== undefined &&
        (await this.seatsUsed(input.tenantId, now, true, tx)) >= limit
      )
        throw new InviteError('SEATS_EXHAUSTED');
      const token = generateInviteToken();
      const row = await tx.operatorInvite.create({
        data: {
          tenantId: input.tenantId,
          email,
          role: input.role,
          tokenHash: hashInviteToken(token),
          expiresAt: inviteExpiry(now),
          createdByPlatformAdminId: input.createdByPlatformAdminId ?? null,
          createdByOperatorId: input.createdByOperatorId ?? null,
        },
      });
      return {
        id: row.id,
        email,
        role: row.role,
        expiresAt: row.expiresAt,
        token,
      };
    };
    return db ? run(db) : this.prisma.$transaction(run);
  }

  async listPending(
    tenantId: string,
    now = new Date(),
  ): Promise<PendingInvite[]> {
    return this.prisma.operatorInvite.findMany({
      where: {
        tenantId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true,
        createdAt: true,
      },
    });
  }

  /** The open invite with this id, or undefined. */
  async findOpen(
    tenantId: string,
    inviteId: string,
    now = new Date(),
  ): Promise<PendingInvite | undefined> {
    const row = await this.prisma.operatorInvite.findFirst({
      where: {
        tenantId,
        id: inviteId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    return row ?? undefined;
  }

  async revoke(
    tenantId: string,
    inviteId: string,
    now = new Date(),
  ): Promise<boolean> {
    const result = await this.prisma.operatorInvite.updateMany({
      where: { tenantId, id: inviteId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    return result.count === 1;
  }

  /** What the invite page shows before the person sets a password. */
  async preview(
    token: string,
    now = new Date(),
  ): Promise<{
    email: string;
    role: TeamRole;
    tenantName: string;
    expiresAt: Date;
  }> {
    if (!plausibleInviteToken(token)) throw new InviteError('INVITE_INVALID');
    const invite = await this.prisma.operatorInvite.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      include: { tenant: { select: { name: true } } },
    });
    if (
      !invite ||
      invite.acceptedAt ||
      invite.revokedAt ||
      invite.expiresAt <= now
    )
      throw new InviteError('INVITE_INVALID');
    return {
      email: invite.email,
      role: invite.role,
      tenantName: invite.tenant.name,
      expiresAt: invite.expiresAt,
    };
  }

  /**
   * Creates the operator and its login from an open invite and marks the
   * invite accepted, atomically. The caller signs the browser in.
   */
  async accept(
    token: string,
    input: { readonly displayName: string; readonly password: string },
    now = new Date(),
  ): Promise<{ tenantId: string; operatorId: string; email: string }> {
    if (!plausibleInviteToken(token)) throw new InviteError('INVITE_INVALID');
    const tokenHash = hashInviteToken(token);
    const found = await this.prisma.operatorInvite.findUnique({
      where: { tokenHash },
      select: { tenantId: true },
    });
    if (!found) throw new InviteError('INVITE_INVALID');
    if (this.access) {
      this.access.invalidate(found.tenantId);
      const { state } = await this.access.check(found.tenantId, now);
      if (state === 'SUSPENDED' || state === 'ARCHIVED')
        throw new InviteError('TENANT_SUSPENDED');
    }
    const passwordHash = await hashPassword(input.password, this.policy.scrypt);
    return this.prisma.$transaction(async (tx) => {
      await lockTenantTeam(tx, found.tenantId);
      const invite = await tx.operatorInvite.findFirst({
        where: {
          tenantId: found.tenantId,
          tokenHash,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
      });
      if (!invite) throw new InviteError('INVITE_INVALID');
      if (
        await tx.operatorCredential.findUnique({
          where: { email: invite.email },
        })
      )
        throw new InviteError('EMAIL_TAKEN');
      const limit = await this.seatLimit(invite.tenantId, tx);
      if (
        limit !== undefined &&
        (await this.seatsUsed(invite.tenantId, now, false, tx)) >= limit
      )
        throw new InviteError('SEATS_EXHAUSTED');
      const operator = await tx.operator.create({
        data: {
          tenantId: invite.tenantId,
          displayName: input.displayName,
          role: invite.role,
        },
      });
      await tx.operatorCredential.create({
        data: {
          tenantId: invite.tenantId,
          operatorId: operator.id,
          email: invite.email,
          passwordHash,
        },
      });
      const marked = await tx.operatorInvite.updateMany({
        where: { tenantId: invite.tenantId, id: invite.id, acceptedAt: null },
        data: { acceptedAt: now, acceptedOperatorId: operator.id },
      });
      if (marked.count !== 1) throw new InviteError('INVITE_INVALID');
      await tx.auditEvent.create({
        data: {
          tenantId: invite.tenantId,
          actorType: 'OPERATOR',
          actorId: operator.id,
          action: 'team.invite_accepted',
          entityType: 'operator',
          entityId: operator.id,
          safeInputSummary: { inviteId: invite.id, role: invite.role },
        },
      });
      return {
        tenantId: invite.tenantId,
        operatorId: operator.id,
        email: invite.email,
      };
    });
  }
}

/** Serializes team changes of one tenant (seat limit, last OWNER). */
export async function lockTenantTeam(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`agentcore:team:${tenantId}`}, 0))) AS lock_result`;
}
