import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import type { Sealed } from '../secrets/secret-cipher.js';

/** The two principal types that can hold a second factor (ADR 048). */
export type MfaSubject =
  | {
      readonly kind: 'OPERATOR';
      readonly tenantId: string;
      readonly operatorId: string;
    }
  | { readonly kind: 'PLATFORM'; readonly adminId: string };

export interface MfaRow {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly lockedUntil: Date | null;
  readonly sealed: Sealed | undefined;
  readonly enabledAt: Date | null;
  readonly lastStep: number | null;
  readonly recoveryHashes: readonly string[];
}

type Db = Pick<
  Prisma.TransactionClient,
  | 'operatorCredential'
  | 'platformAdmin'
  | 'auditEvent'
  | 'platformAuditEvent'
  | '$queryRaw'
>;

interface Updater {
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
}

const bytes = (value: Uint8Array): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(value);

/** Persistence of second-factor state for both principal types; every query is scoped to its subject. */
export class MfaStore {
  constructor(private readonly prisma: PrismaService) {}

  private scope(subject: MfaSubject): Record<string, unknown> {
    return subject.kind === 'OPERATOR'
      ? { tenantId: subject.tenantId, operatorId: subject.operatorId }
      : { id: subject.adminId };
  }

  private updater(db: Db, subject: MfaSubject): Updater {
    return (subject.kind === 'OPERATOR'
      ? db.operatorCredential
      : db.platformAdmin) as unknown as Updater;
  }

  async load(subject: MfaSubject): Promise<MfaRow | undefined> {
    const row =
      subject.kind === 'OPERATOR'
        ? await this.prisma.operatorCredential.findFirst({
            where: {
              tenantId: subject.tenantId,
              operatorId: subject.operatorId,
            },
          })
        : await this.prisma.platformAdmin.findFirst({
            where: { id: subject.adminId, isActive: true },
          });
    if (!row) return undefined;
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.passwordHash,
      lockedUntil: row.lockedUntil,
      sealed:
        row.totpKeyId && row.totpNonce && row.totpCiphertext
          ? {
              keyId: row.totpKeyId,
              nonce: Buffer.from(row.totpNonce),
              ciphertext: Buffer.from(row.totpCiphertext),
            }
          : undefined,
      enabledAt: row.totpEnabledAt,
      lastStep: row.totpLastStep,
      recoveryHashes: row.mfaRecoveryHashes,
    };
  }

  /** Stores a pending secret; refused once MFA is on. */
  async savePending(subject: MfaSubject, sealed: Sealed): Promise<boolean> {
    const { count } = await this.updater(this.prisma, subject).updateMany({
      where: { ...this.scope(subject), totpEnabledAt: null },
      data: {
        totpKeyId: sealed.keyId,
        totpNonce: bytes(sealed.nonce),
        totpCiphertext: bytes(sealed.ciphertext),
        totpLastStep: null,
        mfaRecoveryHashes: [],
      },
    });
    return count === 1;
  }

  /** Turns the pending secret on; false when it was already on or no secret is pending. */
  async activate(
    db: Db,
    subject: MfaSubject,
    step: number,
    hashes: string[],
    now: Date,
  ): Promise<boolean> {
    const { count } = await this.updater(db, subject).updateMany({
      where: {
        ...this.scope(subject),
        totpEnabledAt: null,
        totpCiphertext: { not: null },
      },
      data: {
        totpEnabledAt: now,
        totpLastStep: step,
        mfaRecoveryHashes: hashes,
      },
    });
    return count === 1;
  }

  /** Replay guard: records the step only if it is newer than the last accepted one. */
  async advanceStep(subject: MfaSubject, step: number): Promise<boolean> {
    const { count } = await this.updater(this.prisma, subject).updateMany({
      where: {
        ...this.scope(subject),
        totpEnabledAt: { not: null },
        OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }],
      },
      data: { totpLastStep: step },
    });
    return count === 1;
  }

  async setRecovery(
    db: Db,
    subject: MfaSubject,
    hashes: string[],
  ): Promise<void> {
    await this.updater(db, subject).updateMany({
      where: { ...this.scope(subject), totpEnabledAt: { not: null } },
      data: { mfaRecoveryHashes: hashes },
    });
  }

  async clear(db: Db, subject: MfaSubject): Promise<void> {
    await this.updater(db, subject).updateMany({
      where: this.scope(subject),
      data: {
        totpKeyId: null,
        totpNonce: null,
        totpCiphertext: null,
        totpEnabledAt: null,
        totpLastStep: null,
        mfaRecoveryHashes: [],
      },
    });
  }

  /** Removes one recovery hash atomically; false when it was not there (single use). */
  async consumeRecovery(subject: MfaSubject, hash: string): Promise<boolean> {
    const rows =
      subject.kind === 'OPERATOR'
        ? await this.prisma.$queryRaw<{ id: string }[]>`
            UPDATE operator_credentials
            SET mfa_recovery_hashes = array_remove(mfa_recovery_hashes, ${hash})
            WHERE tenant_id = ${subject.tenantId}::uuid
              AND operator_id = ${subject.operatorId}::uuid
              AND totp_enabled_at IS NOT NULL
              AND ${hash} = ANY(mfa_recovery_hashes)
            RETURNING id`
        : await this.prisma.$queryRaw<{ id: string }[]>`
            UPDATE platform_admins
            SET mfa_recovery_hashes = array_remove(mfa_recovery_hashes, ${hash})
            WHERE id = ${subject.adminId}::uuid
              AND totp_enabled_at IS NOT NULL
              AND ${hash} = ANY(mfa_recovery_hashes)
            RETURNING id`;
    return rows.length === 1;
  }

  /**
   * Counts a wrong second factor toward the account lock (same rule as a
   * wrong password, ADR 020). Returns whether this failure locked the account.
   */
  async registerFailure(
    subject: MfaSubject,
    now: Date,
    maxFailed: number,
    lockMs: number,
  ): Promise<boolean> {
    const lockUntil = new Date(now.getTime() + lockMs);
    const rows =
      subject.kind === 'OPERATOR'
        ? await this.prisma.$queryRaw<{ locked: boolean }[]>`
            UPDATE operator_credentials
            SET failed_attempts = CASE
                  WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= ${now} THEN 1 ELSE failed_attempts + 1 END) >= ${maxFailed} THEN 0
                  ELSE (CASE WHEN locked_until IS NOT NULL AND locked_until <= ${now} THEN 1 ELSE failed_attempts + 1 END)
                END,
                locked_until = CASE
                  WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= ${now} THEN 1 ELSE failed_attempts + 1 END) >= ${maxFailed} THEN ${lockUntil}::timestamptz
                  ELSE NULL
                END
            WHERE tenant_id = ${subject.tenantId}::uuid
              AND operator_id = ${subject.operatorId}::uuid
              AND (locked_until IS NULL OR locked_until <= ${now})
            RETURNING (locked_until IS NOT NULL) AS locked`
        : await this.prisma.$queryRaw<{ locked: boolean }[]>`
            UPDATE platform_admins
            SET failed_attempts = CASE
                  WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= ${now} THEN 1 ELSE failed_attempts + 1 END) >= ${maxFailed} THEN 0
                  ELSE (CASE WHEN locked_until IS NOT NULL AND locked_until <= ${now} THEN 1 ELSE failed_attempts + 1 END)
                END,
                locked_until = CASE
                  WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= ${now} THEN 1 ELSE failed_attempts + 1 END) >= ${maxFailed} THEN ${lockUntil}::timestamptz
                  ELSE NULL
                END
            WHERE id = ${subject.adminId}::uuid
              AND (locked_until IS NULL OR locked_until <= ${now})
            RETURNING (locked_until IS NOT NULL) AS locked`;
    return rows[0]?.locked === true;
  }

  /** Clears the failure counter after a fully verified sign-in. */
  async resetFailures(db: Db, subject: MfaSubject): Promise<void> {
    await this.updater(db, subject).updateMany({
      where: this.scope(subject),
      data: { failedAttempts: 0, lockedUntil: null },
    });
  }

  /** One audit row per MFA write; never a secret or a code. */
  async audit(
    db: Db,
    subject: MfaSubject,
    action: string,
    summary: Record<string, string | number | boolean | null> = {},
  ): Promise<void> {
    if (subject.kind === 'OPERATOR')
      await db.auditEvent.create({
        data: {
          tenantId: subject.tenantId,
          actorType: 'OPERATOR',
          actorId: subject.operatorId,
          action,
          entityType: 'operator',
          entityId: subject.operatorId,
          safeInputSummary: summary,
        },
      });
    else
      await db.platformAuditEvent.create({
        data: {
          actorAdminId: subject.adminId,
          action,
          entityType: 'platform_admin',
          entityId: subject.adminId,
          safeSummary: summary,
        },
      });
  }
}
