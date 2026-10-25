import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
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
  | { readonly ok: false; readonly code: 'INVALID_CREDENTIALS' | 'LOCKED' };

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

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
      const failed = credential.failedAttempts + 1;
      const lock = failed >= this.policy.maxFailedAttempts;
      await this.prisma.operatorCredential.update({
        where: { id: credential.id },
        data: {
          failedAttempts: lock ? 0 : failed,
          lockedUntil: lock
            ? new Date(now.getTime() + this.policy.lockMs)
            : null,
        },
      });
      return { ok: false, code: 'INVALID_CREDENTIALS' };
    }
    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.policy.absoluteTtlMs);
    await this.prisma.$transaction([
      this.prisma.operatorCredential.update({
        where: { id: credential.id },
        data: { failedAttempts: 0, lockedUntil: null },
      }),
      this.prisma.operatorSession.create({
        data: {
          tenantId: credential.tenantId,
          operatorId: credential.operatorId,
          tokenHash: sha256(sessionToken),
          csrfHash: sha256(csrfToken),
          lastSeenAt: now,
          expiresAt,
        },
      }),
    ]);
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

  /** Creates or replaces the web login of an operator (admin/setup use). */
  async setPassword(
    tenantId: string,
    operatorId: string,
    emailInput: string,
    password: string,
  ): Promise<void> {
    const email = emailInput.trim().toLowerCase();
    const passwordHash = await hashPassword(password, this.policy.scrypt);
    await this.prisma.operatorCredential.upsert({
      where: { operatorId },
      create: { tenantId, operatorId, email, passwordHash },
      update: { email, passwordHash, failedAttempts: 0, lockedUntil: null },
    });
  }
}
