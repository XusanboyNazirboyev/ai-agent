import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { MfaError, MfaService, type MfaSubject } from '../auth/mfa.service.js';
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
  | { readonly ok: false; readonly code: 'INVALID_CREDENTIALS' | 'LOCKED' }
  /** ADR 048: correct password, no session yet; a code (or first enrolment) is owed. */
  | {
      readonly ok: false;
      readonly code: 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED';
      readonly challenge: string;
    }
  | { readonly ok: false; readonly code: 'MFA_NOT_AVAILABLE' };

type PlatformSignedIn = Extract<PlatformLoginResult, { ok: true }>;

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
    @Optional() private readonly mfa?: MfaService,
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
      // ADR 048 §4-5: platform admins always need a second factor. Without a
      // keyring neither step is possible, so sign-in is refused (fail closed).
      // The failure counter is not reset here: wrong codes must keep counting.
      if (!this.mfa) return { ok: false, code: 'INVALID_CREDENTIALS' };
      if (!this.mfa.available) return { ok: false, code: 'MFA_NOT_AVAILABLE' };
      const subject: MfaSubject = { kind: 'PLATFORM', adminId: admin.id };
      const enrolled = admin.totpEnabledAt !== null;
      return {
        ok: false,
        code: enrolled ? 'MFA_REQUIRED' : 'MFA_ENROLLMENT_REQUIRED',
        challenge: await this.mfa.createChallenge(
          subject,
          enrolled ? 'LOGIN' : 'ENROLL',
          now,
        ),
      };
    }
    return { ok: false, code: 'INVALID_CREDENTIALS' };
  }

  /** Second step of a sign-in: verifies the factor of a LOGIN challenge, then opens the session. */
  async loginWithMfa(
    challenge: string,
    factor: { code?: string | undefined; recoveryCode?: string | undefined },
    now = new Date(),
  ): Promise<PlatformSignedIn> {
    if (!this.mfa) throw new MfaError('MFA_NOT_AVAILABLE');
    const { subject } = await this.mfa.verifyLogin(challenge, factor, now);
    return this.openForSubject(subject, now);
  }

  /** Forced first enrolment: confirms the pending secret, then opens the session. */
  async enrollAndLogin(
    challenge: string,
    code: string,
    now = new Date(),
  ): Promise<PlatformSignedIn & { recoveryCodes: string[] }> {
    if (!this.mfa) throw new MfaError('MFA_NOT_AVAILABLE');
    const { subject, recoveryCodes } = await this.mfa.enableWithChallenge(
      challenge,
      code,
      now,
    );
    return { ...(await this.openForSubject(subject, now)), recoveryCodes };
  }

  private async openForSubject(
    subject: MfaSubject,
    now: Date,
  ): Promise<PlatformSignedIn> {
    if (subject.kind !== 'PLATFORM')
      throw new MfaError('MFA_CHALLENGE_INVALID');
    const admin = await this.prisma.platformAdmin.findFirst({
      where: { id: subject.adminId, isActive: true },
    });
    if (!admin) throw new MfaError('MFA_CHALLENGE_INVALID');
    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.policy.absoluteTtlMs);
    await this.prisma.$transaction(async (tx) => {
      await tx.platformAdmin.updateMany({
        where: { id: admin.id },
        data: { failedAttempts: 0, lockedUntil: null },
      });
      await tx.platformSession.create({
        data: {
          adminId: admin.id,
          tokenHash: sha256(sessionToken),
          csrfHash: sha256(csrfToken),
          lastSeenAt: now,
          expiresAt,
        },
      });
    });
    return {
      ok: true,
      sessionToken,
      csrfToken,
      expiresAt,
      admin: {
        id: admin.id,
        email: admin.email,
        displayName: admin.displayName,
        role: admin.role,
      },
    };
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
