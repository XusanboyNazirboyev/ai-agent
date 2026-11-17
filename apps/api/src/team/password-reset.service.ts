import { Inject, Injectable, Optional } from '@nestjs/common';
import { TenantAccessService } from '../access/tenant-access.service.js';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { runWithTenant } from '../persistence/tenant-context.js';
import { hashPassword } from '../webinbox/password.js';
import {
  DEFAULT_SESSION_POLICY,
  SESSION_POLICY,
  type SessionPolicy,
} from '../webinbox/session.service.js';
import {
  generateInviteToken,
  hashInviteToken,
  plausibleInviteToken,
} from './invite-token.js';

/** A reset link is valid for 24 hours (ADR 047 amendment 2026-11-17). */
export const RESET_TTL_MS = 24 * 60 * 60 * 1000;

export type ResetErrorCode =
  'RESET_INVALID' | 'NOT_FOUND' | 'OPERATOR_INACTIVE' | 'TENANT_SUSPENDED';

export class PasswordResetError extends Error {
  constructor(readonly code: ResetErrorCode) {
    super(code);
    this.name = 'PasswordResetError';
  }
}

export interface IssuedReset {
  /** Plain token: returned once, never stored or logged. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly email: string;
  readonly displayName: string;
}

type Db = Prisma.TransactionClient | PrismaService;

/**
 * One-time password reset links (ADR 047 amendment 2026-11-17). A platform
 * admin or the tenant's OWNER/ADMIN makes one for a person and sends it by
 * hand (there is no e-mail); the person sets a new password with it. Only
 * the token's hash is stored, a new link retires the previous ones, and
 * using a link signs that person out everywhere. MFA stays as it was: the
 * next sign-in still asks for the second factor.
 */
@Injectable()
export class PasswordResetService {
  /** Finds a reset by its token alone, before the tenant is known (RLS S5). */
  private readonly lookup: PrismaClient;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(SESSION_POLICY)
    private readonly policy: SessionPolicy = DEFAULT_SESSION_POLICY,
    @Optional() private readonly access?: TenantAccessService,
    @Optional() privileged?: PrivilegedDatabase,
  ) {
    this.lookup = privileged?.db ?? prisma;
  }

  async issue(
    input: {
      readonly tenantId: string;
      readonly operatorId: string;
      readonly createdByPlatformAdminId?: string;
      readonly createdByOperatorId?: string;
    },
    db: Db = this.prisma,
    now = new Date(),
  ): Promise<IssuedReset> {
    const operator = await db.operator.findFirst({
      where: { tenantId: input.tenantId, id: input.operatorId },
      select: {
        displayName: true,
        isActive: true,
        credentials: { select: { email: true }, take: 1 },
      },
    });
    const email = operator?.credentials[0]?.email;
    if (!operator || !email) throw new PasswordResetError('NOT_FOUND');
    if (!operator.isActive) throw new PasswordResetError('OPERATOR_INACTIVE');
    await db.operatorPasswordReset.updateMany({
      where: {
        tenantId: input.tenantId,
        operatorId: input.operatorId,
        usedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
    const token = generateInviteToken();
    const expiresAt = new Date(now.getTime() + RESET_TTL_MS);
    await db.operatorPasswordReset.create({
      data: {
        tenantId: input.tenantId,
        operatorId: input.operatorId,
        tokenHash: hashInviteToken(token),
        expiresAt,
        createdByPlatformAdminId: input.createdByPlatformAdminId ?? null,
        createdByOperatorId: input.createdByOperatorId ?? null,
      },
    });
    return { token, expiresAt, email, displayName: operator.displayName };
  }

  /** What the reset page shows; the token itself is the credential. */
  async preview(
    token: string,
    now = new Date(),
  ): Promise<{
    email: string;
    displayName: string;
    tenantName: string;
    expiresAt: Date;
  }> {
    const reset = await this.open(token, now);
    return runWithTenant(reset.tenantId, async () => {
      const operator = await this.prisma.operator.findFirst({
        where: { tenantId: reset.tenantId, id: reset.operatorId },
        select: {
          displayName: true,
          credentials: { select: { email: true }, take: 1 },
          tenant: { select: { name: true } },
        },
      });
      const email = operator?.credentials[0]?.email;
      if (!operator || !email) throw new PasswordResetError('RESET_INVALID');
      return {
        email,
        displayName: operator.displayName,
        tenantName: operator.tenant.name,
        expiresAt: reset.expiresAt,
      };
    });
  }

  /**
   * Sets the new password, retires the link, clears a lockout and signs the
   * person out everywhere, atomically. The caller does not sign in: the
   * person signs in with the new password (and MFA, if enabled).
   */
  async complete(
    token: string,
    password: string,
    now = new Date(),
  ): Promise<{ tenantId: string; operatorId: string }> {
    const reset = await this.open(token, now);
    if (this.access) {
      this.access.invalidate(reset.tenantId);
      const { state } = await this.access.check(reset.tenantId, now);
      if (state === 'SUSPENDED' || state === 'ARCHIVED')
        throw new PasswordResetError('TENANT_SUSPENDED');
    }
    const passwordHash = await hashPassword(password, this.policy.scrypt);
    return runWithTenant(reset.tenantId, () =>
      this.prisma.$transaction(async (tx) => {
        const used = await tx.operatorPasswordReset.updateMany({
          where: {
            id: reset.id,
            usedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: { usedAt: now },
        });
        if (used.count !== 1) throw new PasswordResetError('RESET_INVALID');
        const changed = await tx.operatorCredential.updateMany({
          where: { tenantId: reset.tenantId, operatorId: reset.operatorId },
          data: { passwordHash, failedAttempts: 0, lockedUntil: null },
        });
        if (changed.count !== 1) throw new PasswordResetError('RESET_INVALID');
        await tx.operatorSession.updateMany({
          where: {
            tenantId: reset.tenantId,
            operatorId: reset.operatorId,
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
        await tx.auditEvent.create({
          data: {
            tenantId: reset.tenantId,
            actorType: 'OPERATOR',
            actorId: reset.operatorId,
            action: 'operator.password_reset',
            entityType: 'operator',
            entityId: reset.operatorId,
            safeInputSummary: { resetId: reset.id },
          },
        });
        return { tenantId: reset.tenantId, operatorId: reset.operatorId };
      }),
    );
  }

  private async open(
    token: string,
    now: Date,
  ): Promise<{
    id: string;
    tenantId: string;
    operatorId: string;
    expiresAt: Date;
  }> {
    if (!plausibleInviteToken(token))
      throw new PasswordResetError('RESET_INVALID');
    const reset = await this.lookup.operatorPasswordReset.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: {
        id: true,
        tenantId: true,
        operatorId: true,
        expiresAt: true,
        usedAt: true,
        revokedAt: true,
      },
    });
    if (!reset || reset.usedAt || reset.revokedAt || reset.expiresAt <= now)
      throw new PasswordResetError('RESET_INVALID');
    return reset;
  }
}
