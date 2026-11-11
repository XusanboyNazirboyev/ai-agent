import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { SECRET_CIPHER } from '../secrets/channel-secret-store.js';
import { SecretCipher } from '../secrets/secret-cipher.js';
import { verifyPassword } from '../webinbox/password.js';
import { MfaStore, type MfaRow, type MfaSubject } from './mfa-store.js';
import {
  DEFAULT_SESSION_POLICY,
  SESSION_POLICY,
  type SessionPolicy,
} from './session-policy.js';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from './totp.js';

export type { MfaSubject } from './mfa-store.js';

export type MfaErrorCode =
  | 'MFA_NOT_AVAILABLE'
  | 'MFA_ALREADY_ENABLED'
  | 'MFA_SETUP_REQUIRED'
  | 'MFA_NOT_ENABLED'
  | 'MFA_INVALID_CODE'
  | 'MFA_CHALLENGE_INVALID'
  | 'MFA_REQUIRED_BY_POLICY'
  | 'INVALID_CREDENTIALS'
  | 'LOCKED';

export class MfaError extends Error {
  constructor(readonly code: MfaErrorCode) {
    super(code);
    this.name = 'MfaError';
  }
}

export type ChallengePurpose = 'LOGIN' | 'ENROLL';
export interface SecondFactor {
  readonly code?: string | undefined;
  readonly recoveryCode?: string | undefined;
}

export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const principalType = (subject: MfaSubject): string =>
  subject.kind === 'OPERATOR' ? 'OPERATOR' : 'PLATFORM_ADMIN';

/**
 * Second factor for both principal types (ADR 048): TOTP secrets sealed with
 * the keyring, recovery codes, and the short-lived challenge between a correct
 * password and a session. It never creates sessions; the two session services
 * do that after this service has verified the factor. No secret, code or
 * challenge token is ever logged or put in an audit row.
 */
@Injectable()
export class MfaService {
  private readonly store: MfaStore;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(SECRET_CIPHER) private readonly cipher?: SecretCipher,
    @Optional()
    @Inject(SESSION_POLICY)
    private readonly policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  ) {
    this.store = new MfaStore(prisma);
  }

  /** False without the keyring: enrolment and verification are refused, never done in clear. */
  get available(): boolean {
    return this.cipher !== undefined;
  }

  private requireCipher(): SecretCipher {
    if (!this.cipher) throw new MfaError('MFA_NOT_AVAILABLE');
    return this.cipher;
  }

  private aad(subject: MfaSubject): string {
    return subject.kind === 'OPERATOR'
      ? `mfa:operator:${subject.tenantId}:${subject.operatorId}`
      : `mfa:platform:${subject.adminId}`;
  }

  private async mustLoad(subject: MfaSubject): Promise<MfaRow> {
    const row = await this.store.load(subject);
    if (!row) throw new MfaError('MFA_CHALLENGE_INVALID');
    return row;
  }

  private secretOf(subject: MfaSubject, row: MfaRow): Buffer {
    if (!row.sealed) throw new MfaError('MFA_SETUP_REQUIRED');
    return base32Decode(
      this.requireCipher().open(row.sealed, this.aad(subject)),
    );
  }

  async status(subject: MfaSubject): Promise<{
    available: boolean;
    enabled: boolean;
    pending: boolean;
    enabledAt: Date | null;
    recoveryCodesRemaining: number;
    required: boolean;
  }> {
    const row = await this.mustLoad(subject);
    return {
      available: this.available,
      enabled: row.enabledAt !== null,
      pending: row.enabledAt === null && row.sealed !== undefined,
      enabledAt: row.enabledAt,
      recoveryCodesRemaining: row.recoveryHashes.length,
      required: subject.kind === 'PLATFORM',
    };
  }

  /** Starts (or restarts) enrolment: a fresh pending secret, shown once. */
  async setup(
    subject: MfaSubject,
  ): Promise<{ secret: string; otpauthUri: string }> {
    const cipher = this.requireCipher();
    const row = await this.mustLoad(subject);
    if (row.enabledAt) throw new MfaError('MFA_ALREADY_ENABLED');
    const secret = generateTotpSecret();
    const text = base32Encode(secret);
    const saved = await this.store.savePending(
      subject,
      cipher.seal(text, this.aad(subject)),
    );
    if (!saved) throw new MfaError('MFA_ALREADY_ENABLED');
    return { secret: text, otpauthUri: otpauthUri(row.email, secret) };
  }

  /** Confirms the pending secret with a code and turns MFA on; returns the recovery codes once. */
  async enable(
    subject: MfaSubject,
    code: string,
    now = new Date(),
  ): Promise<{ recoveryCodes: string[] }> {
    const row = await this.mustLoad(subject);
    this.assertNotLocked(row, now);
    if (row.enabledAt) throw new MfaError('MFA_ALREADY_ENABLED');
    const secret = this.secretOf(subject, row);
    const step = verifyTotp(secret, code, now.getTime(), null);
    if (step === undefined) throw await this.failure(subject, now);
    const recoveryCodes = generateRecoveryCodes();
    const done = await this.prisma.$transaction(async (tx) => {
      const ok = await this.store.activate(
        tx,
        subject,
        step,
        recoveryCodes.map((c) => hashRecoveryCode(secret, normalized(c))),
        now,
      );
      if (ok) await this.store.audit(tx, subject, 'auth.mfa_enabled');
      return ok;
    });
    if (!done) throw new MfaError('MFA_ALREADY_ENABLED');
    return { recoveryCodes };
  }

  async regenerateRecoveryCodes(
    subject: MfaSubject,
    code: string,
    now = new Date(),
  ): Promise<{ recoveryCodes: string[] }> {
    const row = await this.mustLoad(subject);
    if (!row.enabledAt) throw new MfaError('MFA_NOT_ENABLED');
    this.assertNotLocked(row, now);
    await this.checkFactor(subject, row, { code }, now);
    const secret = this.secretOf(subject, row);
    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await this.store.setRecovery(
        tx,
        subject,
        recoveryCodes.map((c) => hashRecoveryCode(secret, normalized(c))),
      );
      await this.store.audit(tx, subject, 'auth.mfa_recovery_regenerated');
    });
    return { recoveryCodes };
  }

  /** Turns MFA off after the password and a code or recovery code; not allowed where it is enforced. */
  async disable(
    subject: MfaSubject,
    password: string,
    factor: SecondFactor,
    now = new Date(),
  ): Promise<void> {
    if (subject.kind === 'PLATFORM')
      throw new MfaError('MFA_REQUIRED_BY_POLICY');
    const row = await this.mustLoad(subject);
    if (!row.enabledAt) throw new MfaError('MFA_NOT_ENABLED');
    this.assertNotLocked(row, now);
    if (
      !row.passwordHash ||
      !(await verifyPassword(password, row.passwordHash))
    )
      throw await this.failure(subject, now, 'INVALID_CREDENTIALS');
    await this.checkFactor(subject, row, factor, now);
    await this.prisma.$transaction(async (tx) => {
      await this.store.clear(tx, subject);
      await this.store.audit(tx, subject, 'auth.mfa_disabled');
    });
  }

  /** Platform owner resets another admin's second factor (ADR 048 consequences); audited. */
  async reset(target: MfaSubject, actorAdminId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.store.clear(tx, target);
      if (target.kind === 'PLATFORM')
        await tx.platformAuditEvent.create({
          data: {
            actorAdminId,
            action: 'admin.mfa_reset',
            entityType: 'platform_admin',
            entityId: target.adminId,
            safeSummary: {},
          },
        });
    });
  }

  // ---- sign-in challenge ----

  async createChallenge(
    subject: MfaSubject,
    purpose: ChallengePurpose,
    now = new Date(),
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.mfaChallenge.create({
      data: {
        principalType: principalType(subject),
        principalId:
          subject.kind === 'OPERATOR' ? subject.operatorId : subject.adminId,
        tenantId: subject.kind === 'OPERATOR' ? subject.tenantId : null,
        purpose,
        tokenHash: sha256(token),
        expiresAt: new Date(now.getTime() + MFA_CHALLENGE_TTL_MS),
      },
    });
    // Housekeeping, best effort: old challenges are useless.
    await this.prisma.mfaChallenge
      .deleteMany({
        where: { expiresAt: { lt: new Date(now.getTime() - 3_600_000) } },
      })
      .catch(() => undefined);
    return token;
  }

  /** Counts one attempt on a live challenge and returns who it belongs to. */
  private async claim(
    token: string,
    purpose: ChallengePurpose,
    now: Date,
  ): Promise<MfaSubject> {
    if (token.length < 20 || token.length > 200)
      throw new MfaError('MFA_CHALLENGE_INVALID');
    const rows = await this.prisma.$queryRaw<
      {
        principal_type: string;
        principal_id: string;
        tenant_id: string | null;
      }[]
    >`
      UPDATE mfa_challenges SET attempts = attempts + 1
      WHERE token_hash = ${sha256(token)}
        AND purpose = ${purpose}
        AND consumed_at IS NULL
        AND expires_at > ${now}
        AND attempts < ${MFA_CHALLENGE_MAX_ATTEMPTS}
      RETURNING principal_type, principal_id, tenant_id`;
    const row = rows[0];
    if (!row) throw new MfaError('MFA_CHALLENGE_INVALID');
    return this.subjectOf(row);
  }

  private subjectOf(row: {
    principal_type: string;
    principal_id: string;
    tenant_id: string | null;
  }): MfaSubject {
    if (row.principal_type === 'OPERATOR' && row.tenant_id)
      return {
        kind: 'OPERATOR',
        tenantId: row.tenant_id,
        operatorId: row.principal_id,
      };
    if (row.principal_type === 'PLATFORM_ADMIN')
      return { kind: 'PLATFORM', adminId: row.principal_id };
    throw new MfaError('MFA_CHALLENGE_INVALID');
  }

  private async consume(token: string, now: Date): Promise<void> {
    const { count } = await this.prisma.mfaChallenge.updateMany({
      where: { tokenHash: sha256(token), consumedAt: null },
      data: { consumedAt: now },
    });
    if (count !== 1) throw new MfaError('MFA_CHALLENGE_INVALID');
  }

  /** Reads an ENROLL challenge without spending an attempt (setup is not a guess). */
  async enrollSubject(token: string, now = new Date()): Promise<MfaSubject> {
    if (token.length < 20 || token.length > 200)
      throw new MfaError('MFA_CHALLENGE_INVALID');
    const row = await this.prisma.mfaChallenge.findFirst({
      where: {
        tokenHash: sha256(token),
        purpose: 'ENROLL',
        consumedAt: null,
        expiresAt: { gt: now },
        attempts: { lt: MFA_CHALLENGE_MAX_ATTEMPTS },
      },
    });
    if (!row) throw new MfaError('MFA_CHALLENGE_INVALID');
    return this.subjectOf({
      principal_type: row.principalType,
      principal_id: row.principalId,
      tenant_id: row.tenantId,
    });
  }

  /** Verifies the second factor of a LOGIN challenge. The session is the caller's job. */
  async verifyLogin(
    token: string,
    factor: SecondFactor,
    now = new Date(),
  ): Promise<{ subject: MfaSubject }> {
    const subject = await this.claim(token, 'LOGIN', now);
    const row = await this.mustLoad(subject);
    if (!row.enabledAt) throw new MfaError('MFA_CHALLENGE_INVALID');
    this.assertNotLocked(row, now);
    const method = await this.checkFactor(subject, row, factor, now);
    await this.consume(token, now);
    if (method === 'recovery')
      await this.store.audit(this.prisma, subject, 'auth.mfa_recovery_used', {
        remaining: row.recoveryHashes.length - 1,
      });
    return { subject };
  }

  /** Confirms the pending secret of an ENROLL challenge; consumes it on success. */
  async enableWithChallenge(
    token: string,
    code: string,
    now = new Date(),
  ): Promise<{ subject: MfaSubject; recoveryCodes: string[] }> {
    const subject = await this.claim(token, 'ENROLL', now);
    const { recoveryCodes } = await this.enable(subject, code, now);
    await this.consume(token, now);
    return { subject, recoveryCodes };
  }

  /** Clears the failure counter once the whole sign-in is verified. */
  async resetFailures(subject: MfaSubject): Promise<void> {
    await this.store.resetFailures(this.prisma, subject);
  }

  // ---- internals ----

  private assertNotLocked(row: MfaRow, now: Date): void {
    if (row.lockedUntil && row.lockedUntil > now) throw new MfaError('LOCKED');
  }

  private async failure(
    subject: MfaSubject,
    now: Date,
    code: MfaErrorCode = 'MFA_INVALID_CODE',
  ): Promise<MfaError> {
    const locked = await this.store.registerFailure(
      subject,
      now,
      this.policy.maxFailedAttempts,
      this.policy.lockMs,
    );
    return new MfaError(locked ? 'LOCKED' : code);
  }

  /** Accepts a TOTP code (once per step) or a recovery code (once); a wrong one counts toward the lock. */
  private async checkFactor(
    subject: MfaSubject,
    row: MfaRow,
    factor: SecondFactor,
    now: Date,
  ): Promise<'totp' | 'recovery'> {
    const secret = this.secretOf(subject, row);
    if (factor.code !== undefined) {
      const step = verifyTotp(secret, factor.code, now.getTime(), row.lastStep);
      if (step !== undefined && (await this.store.advanceStep(subject, step)))
        return 'totp';
    } else if (factor.recoveryCode !== undefined) {
      const code = normalizeRecoveryCode(factor.recoveryCode);
      if (
        code !== undefined &&
        (await this.store.consumeRecovery(
          subject,
          hashRecoveryCode(secret, code),
        ))
      )
        return 'recovery';
    }
    throw await this.failure(subject, now);
  }
}

function normalized(code: string): string {
  return code.replace('-', '');
}
