import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { TenantAccessService } from '../access/tenant-access.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  DEFAULT_SCRYPT,
  hashPassword,
  verifyPassword,
  type ScryptParams,
} from './password.js';

export type InboxRole = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

export interface InboxPrincipal {
  readonly tenantId: string;
  readonly operatorId: string;
  readonly role: InboxRole;
  readonly sessionId: string;
}

export interface SessionPolicy {
  readonly absoluteTtlMs: number;
  readonly idleTtlMs: number;
  readonly maxFailedAttempts: number;
  readonly lockMs: number;
  readonly scrypt: ScryptParams;
}

export const SESSION_POLICY = Symbol('SESSION_POLICY');

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  absoluteTtlMs: 12 * 60 * 60 * 1000,
  idleTtlMs: 2 * 60 * 60 * 1000,
  maxFailedAttempts: 5,
  lockMs: 15 * 60 * 1000,
  scrypt: DEFAULT_SCRYPT,
};

export type LoginResult =
  | {
      readonly ok: true;
      readonly sessionToken: string;
      readonly csrfToken: string;
      readonly expiresAt: Date;
      readonly principal: Omit<InboxPrincipal, 'sessionId'> & {
        displayName: string;
      };
    }
  | {
      readonly ok: false;
      readonly code: 'INVALID_CREDENTIALS' | 'LOCKED' | 'TENANT_SUSPENDED';
    };

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const MAX_CREDENTIAL_RACE_RETRIES = 20;

export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Operator browser sessions (ADR 020). Cookie value and CSRF token are random;
 * only their SHA-256 is stored. A login failure never says whether the email
 * exists: unknown emails verify against a dummy hash to equalize timing.
 */
@Injectable()
export class SessionService {
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(SESSION_POLICY)
    private readonly policy: SessionPolicy = DEFAULT_SESSION_POLICY,
    @Optional() private readonly access?: TenantAccessService,
  ) {}

  private dummy(): Promise<string> {
    this.dummyHash ??= hashPassword('not-a-real-password', this.policy.scrypt);
    return this.dummyHash;
  }

  async login(
    emailInput: string,
    password: string,
    now = new Date(),
  ): Promise<LoginResult> {
    const email = emailInput.trim().toLowerCase();
    for (let attempt = 0; attempt < MAX_CREDENTIAL_RACE_RETRIES; attempt += 1) {
      const credential = await this.prisma.operatorCredential.findUnique({
        where: { email },
        include: { operator: true },
      });
      if (!credential) {
        await verifyPassword(password, await this.dummy());
        return { ok: false, code: 'INVALID_CREDENTIALS' };
      }
      if (credential.lockedUntil && credential.lockedUntil > now) {
        return { ok: false, code: 'LOCKED' };
      }
      const valid = await verifyPassword(password, credential.passwordHash);
      const usable =
        credential.operator.isActive && credential.operator.role !== undefined;
      if (!valid || !usable) {
        const failure = await this.recordFailure(credential, now);
        if (failure === 'retry') continue;
        return {
          ok: false,
          code: failure === 'locked' ? 'LOCKED' : 'INVALID_CREDENTIALS',
        };
      }
      // ADR 047: a suspended or archived tenant cannot sign in. Checked only
      // after the password, so the answer reveals nothing to a stranger.
      if (this.access) {
        const { state } = await this.access.check(credential.tenantId, now);
        if (state === 'SUSPENDED' || state === 'ARCHIVED')
          return { ok: false, code: 'TENANT_SUSPENDED' };
      }

      const sessionToken = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + this.policy.absoluteTtlMs);
      const committed = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.operatorCredential.updateMany({
          where: {
            id: credential.id,
            tenantId: credential.tenantId,
            operatorId: credential.operatorId,
            passwordHash: credential.passwordHash,
            failedAttempts: credential.failedAttempts,
            lockedUntil: credential.lockedUntil,
          },
          data: { failedAttempts: 0, lockedUntil: null },
        });
        if (updated.count !== 1) return false;
        await tx.operatorSession.create({
          data: {
            tenantId: credential.tenantId,
            operatorId: credential.operatorId,
            tokenHash: sha256(sessionToken),
            csrfHash: sha256(csrfToken),
            lastSeenAt: now,
            expiresAt,
          },
        });
        return true;
      });
      if (!committed) continue;
      return {
        ok: true,
        sessionToken,
        csrfToken,
        expiresAt,
        principal: {
          tenantId: credential.tenantId,
          operatorId: credential.operatorId,
          role: credential.operator.role,
          displayName: credential.operator.displayName,
        },
      };
    }
    return { ok: false, code: 'INVALID_CREDENTIALS' };
  }

  private async recordFailure(
    snapshot: {
      id: string;
      tenantId: string;
      operatorId: string;
      passwordHash: string;
      failedAttempts: number;
      lockedUntil: Date | null;
    },
    now: Date,
  ): Promise<'recorded' | 'locked' | 'retry'> {
    const lockUntil = new Date(now.getTime() + this.policy.lockMs);
    const updated = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE operator_credentials
      SET failed_attempts = CASE
            WHEN (CASE
              WHEN locked_until IS NOT NULL AND locked_until <= ${now} THEN 1
              ELSE failed_attempts + 1
            END) >= ${this.policy.maxFailedAttempts} THEN 0
            ELSE CASE
              WHEN locked_until IS NOT NULL AND locked_until <= ${now} THEN 1
              ELSE failed_attempts + 1
            END
          END,
          locked_until = CASE
            WHEN (CASE
              WHEN locked_until IS NOT NULL AND locked_until <= ${now} THEN 1
              ELSE failed_attempts + 1
            END) >= ${this.policy.maxFailedAttempts} THEN ${lockUntil}::timestamptz
            ELSE NULL
          END
      WHERE id = ${snapshot.id}::uuid
        AND tenant_id = ${snapshot.tenantId}::uuid
        AND operator_id = ${snapshot.operatorId}::uuid
        AND password_hash = ${snapshot.passwordHash}
        AND (locked_until IS NULL OR locked_until <= ${now})
      RETURNING id
    `;
    if (updated.length > 0) return 'recorded';

    const current = await this.prisma.operatorCredential.findUnique({
      where: { id: snapshot.id },
      select: {
        passwordHash: true,
        lockedUntil: true,
      },
    });
    if (!current || current.passwordHash !== snapshot.passwordHash) {
      return 'retry';
    }
    return current.lockedUntil && current.lockedUntil > now
      ? 'locked'
      : 'retry';
  }

  /** Resolves a cookie token to a principal, or undefined. Tenant comes from the row. */
  async resolve(
    sessionToken: string,
    now = new Date(),
  ): Promise<(InboxPrincipal & { csrfHash: string }) | undefined> {
    if (sessionToken.length < 20 || sessionToken.length > 200) return undefined;
    const session = await this.prisma.operatorSession.findUnique({
      where: { tokenHash: sha256(sessionToken) },
      include: { operator: true },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      now.getTime() - session.lastSeenAt.getTime() > this.policy.idleTtlMs ||
      !session.operator.isActive
    )
      return undefined;
    // Touch at most once a minute: bookkeeping must not become a write storm.
    if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
      await this.prisma.operatorSession
        .updateMany({ where: { id: session.id }, data: { lastSeenAt: now } })
        .catch(() => undefined);
    }
    return {
      tenantId: session.tenantId,
      operatorId: session.operatorId,
      role: session.operator.role,
      sessionId: session.id,
      csrfHash: session.csrfHash,
    };
  }

  csrfMatches(csrfHash: string, presented: string | undefined): boolean {
    if (!presented || presented.length > 200) return false;
    return hashesEqual(csrfHash, sha256(presented));
  }

  async logout(sessionId: string, tenantId: string): Promise<void> {
    await this.prisma.operatorSession.updateMany({
      where: { id: sessionId, tenantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Checks an established stream without refreshing its idle-session clock. */
  async isSessionActive(
    principal: Pick<InboxPrincipal, 'tenantId' | 'operatorId' | 'sessionId'>,
    now = new Date(),
  ): Promise<boolean> {
    const session = await this.prisma.operatorSession.findFirst({
      where: {
        id: principal.sessionId,
        tenantId: principal.tenantId,
        operatorId: principal.operatorId,
        revokedAt: null,
        expiresAt: { gt: now },
        lastSeenAt: {
          gte: new Date(now.getTime() - this.policy.idleTtlMs),
        },
        operator: { isActive: true },
      },
      select: { id: true },
    });
    return session !== null;
  }

  /** Creates or replaces the web login of an operator (admin/setup use). */
  async setPassword(
    tenantId: string,
    operatorId: string,
    emailInput: string,
    password: string,
  ): Promise<void> {
    const email = emailInput.trim().toLowerCase();
    const passwordHash = await hashPassword(password, this.policy.scrypt);
    await this.prisma.$transaction(async (tx) => {
      await tx.operatorCredential.upsert({
        where: { operatorId, tenantId },
        create: { tenantId, operatorId, email, passwordHash },
        update: {
          email,
          passwordHash,
          failedAttempts: 0,
          lockedUntil: null,
        },
      });
      await tx.operatorSession.updateMany({
        where: { tenantId, operatorId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }
}
