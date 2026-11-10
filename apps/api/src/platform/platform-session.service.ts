import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { hashPassword, verifyPassword } from '../webinbox/password.js';
import {
  DEFAULT_SESSION_POLICY,
  hashesEqual,
  SESSION_POLICY,
  type SessionPolicy,
} from '../webinbox/session.service.js';

export type PlatformRoleName = 'PLATFORM_OWNER' | 'PLATFORM_SUPPORT';

export interface PlatformPrincipal {
  readonly adminId: string;
  readonly role: PlatformRoleName;
  readonly sessionId: string;
}

export type PlatformLoginResult =
  | {
      readonly ok: true;
      readonly sessionToken: string;
      readonly csrfToken: string;
      readonly expiresAt: Date;
      readonly admin: {
        readonly id: string;
        readonly email: string;
        readonly displayName: string;
        readonly role: PlatformRoleName;
      };
    }
  | { readonly ok: false; readonly code: 'INVALID_CREDENTIALS' | 'LOCKED' };

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const MAX_RACE_RETRIES = 20;

/**
 * Platform admin browser sessions (ADR 047 §1). Same policy as operator
 * sessions (ADR 020): random cookie and CSRF tokens stored as SHA-256,
 * scrypt passwords, dummy verification for unknown emails, account lock
 * after repeated failures. Separate tables: a platform session never
 * resolves on a tenant endpoint and vice versa.
 */
@Injectable()
export class PlatformSessionService {
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(SESSION_POLICY)
    readonly policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  ) {}

  private dummy(): Promise<string> {
    this.dummyHash ??= hashPassword('not-a-real-password', this.policy.scrypt);
    return this.dummyHash;
  }

  async login(
    emailInput: string,
    password: string,
    now = new Date(),
  ): Promise<PlatformLoginResult> {
    const email = emailInput.trim().toLowerCase();
    for (let attempt = 0; attempt < MAX_RACE_RETRIES; attempt += 1) {
      const admin = await this.prisma.platformAdmin.findUnique({
        where: { email },
      });
      if (!admin || !admin.passwordHash) {
        await verifyPassword(password, await this.dummy());
        return { ok: false, code: 'INVALID_CREDENTIALS' };
      }
      if (admin.lockedUntil && admin.lockedUntil > now)
        return { ok: false, code: 'LOCKED' };
      const valid = await verifyPassword(password, admin.passwordHash);
      if (!valid || !admin.isActive) {
        const failure = await this.recordFailure(
          { id: admin.id, passwordHash: admin.passwordHash },
          now,
        );
        if (failure === 'retry') continue;
        return {
          ok: false,
          code: failure === 'locked' ? 'LOCKED' : 'INVALID_CREDENTIALS',
        };
      }
      const opened = await this.open(
        {
          id: admin.id,
          passwordHash: admin.passwordHash,
          failedAttempts: admin.failedAttempts,
          lockedUntil: admin.lockedUntil,
        },
        now,
      );
      if (!opened) continue;
      return {
        ok: true,
        ...opened,
        admin: {
          id: admin.id,
          email: admin.email,
          displayName: admin.displayName,
          role: admin.role,
        },
      };
    }
    return { ok: false, code: 'INVALID_CREDENTIALS' };
  }

  /** Opens a session if the credential snapshot is unchanged; resets failures. */
  private async open(
    snapshot: {
      id: string;
      passwordHash: string;
      failedAttempts: number;
      lockedUntil: Date | null;
    },
    now: Date,
  ): Promise<
    { sessionToken: string; csrfToken: string; expiresAt: Date } | undefined
  > {
    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.policy.absoluteTtlMs);
    const committed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.platformAdmin.updateMany({
        where: {
          id: snapshot.id,
          isActive: true,
          passwordHash: snapshot.passwordHash,
          failedAttempts: snapshot.failedAttempts,
          lockedUntil: snapshot.lockedUntil,
        },
        data: { failedAttempts: 0, lockedUntil: null },
      });
      if (updated.count !== 1) return false;
      await tx.platformSession.create({
        data: {
          adminId: snapshot.id,
          tokenHash: sha256(sessionToken),
          csrfHash: sha256(csrfToken),
          lastSeenAt: now,
          expiresAt,
        },
      });
      return true;
    });
    return committed ? { sessionToken, csrfToken, expiresAt } : undefined;
  }

  private async recordFailure(
    snapshot: { id: string; passwordHash: string },
    now: Date,
  ): Promise<'recorded' | 'locked' | 'retry'> {
    const lockUntil = new Date(now.getTime() + this.policy.lockMs);
    const max = this.policy.maxFailedAttempts;
    const updated = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE platform_admins
      SET failed_attempts = CASE
            WHEN (CASE
              WHEN locked_until IS NOT NULL AND locked_until <= ${now} THEN 1
              ELSE failed_attempts + 1
            END) >= ${max} THEN 0
            ELSE CASE
              WHEN locked_until IS NOT NULL AND locked_until <= ${now} THEN 1
              ELSE failed_attempts + 1
            END
          END,
          locked_until = CASE
            WHEN (CASE
              WHEN locked_until IS NOT NULL AND locked_until <= ${now} THEN 1
              ELSE failed_attempts + 1
            END) >= ${max} THEN ${lockUntil}::timestamptz
            ELSE NULL
          END
      WHERE id = ${snapshot.id}::uuid
        AND password_hash = ${snapshot.passwordHash}
        AND (locked_until IS NULL OR locked_until <= ${now})
      RETURNING id
    `;
    if (updated.length > 0) return 'recorded';
    const current = await this.prisma.platformAdmin.findUnique({
      where: { id: snapshot.id },
      select: { passwordHash: true, lockedUntil: true },
    });
    if (!current || current.passwordHash !== snapshot.passwordHash)
      return 'retry';
    return current.lockedUntil && current.lockedUntil > now
      ? 'locked'
      : 'retry';
  }

  async resolve(
    sessionToken: string,
    now = new Date(),
  ): Promise<(PlatformPrincipal & { csrfHash: string }) | undefined> {
    if (sessionToken.length < 20 || sessionToken.length > 200) return undefined;
    const session = await this.prisma.platformSession.findUnique({
      where: { tokenHash: sha256(sessionToken) },
      include: { admin: true },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      now.getTime() - session.lastSeenAt.getTime() > this.policy.idleTtlMs ||
      !session.admin.isActive
    )
      return undefined;
    if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
      await this.prisma.platformSession
        .updateMany({ where: { id: session.id }, data: { lastSeenAt: now } })
        .catch(() => undefined);
    }
    return {
      adminId: session.adminId,
      role: session.admin.role,
      sessionId: session.id,
      csrfHash: session.csrfHash,
    };
  }

  csrfMatches(csrfHash: string, presented: string | undefined): boolean {
    if (!presented || presented.length > 200) return false;
    return hashesEqual(csrfHash, sha256(presented));
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.platformSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Ends every session of an admin (deactivation). */
  async revokeAll(adminId: string, now = new Date()): Promise<void> {
    await this.prisma.platformSession.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt: now },
    });
  }
}
