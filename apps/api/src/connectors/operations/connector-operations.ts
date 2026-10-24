import { randomBytes } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import type { WriteIdempotency } from '../interfaces/crm-connector.js';
import type { PreviousAttempt, WriteExecution } from './write-policy.js';

type Tx = Prisma.TransactionClient;

export interface OperationRef {
  readonly tenantId: string;
  readonly kind: string;
  readonly subjectType: string;
  readonly subjectId: string;
}

export interface ClaimedOperation {
  readonly id: string;
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly leaseToken: string;
  /** Attempt number of this claim (1 = first). */
  readonly attempt: number;
  readonly previous: PreviousAttempt;
}

export type ClaimResult =
  | { readonly claimed: true; readonly operation: ClaimedOperation }
  | {
      readonly claimed: false;
      readonly reason: 'BUSY' | 'NOT_DUE' | 'TERMINAL';
      readonly status: string;
      readonly externalId: string | null;
    };

const TERMINAL = new Set([
  'SUCCEEDED',
  'FAILED',
  'UNCERTAIN',
  'RESOLVED_SUCCEEDED',
  'RESOLVED_FAILED',
]);

/**
 * Persistence of logical external writes (ADR 023). Generic: the kind and
 * subject say what is written; nothing here knows a domain or a vendor.
 * Every state change is tenant-scoped and, while an attempt runs, guarded by
 * its lease token, so a worker that lost its lease cannot overwrite the
 * outcome recorded by another.
 */
export class ConnectorOperations {
  constructor(private readonly prisma: PrismaService) {}

  /** The key for every attempt of this logical write: derived, never random. */
  static keyFor(ref: OperationRef): string {
    return `${ref.kind}:${ref.subjectType}:${ref.subjectId}`;
  }

  async find(ref: OperationRef): Promise<{
    id: string;
    status: string;
    externalId: string | null;
  } | null> {
    return this.prisma.connectorOperation.findUnique({
      where: {
        tenantId_kind_subjectType_subjectId: {
          tenantId: ref.tenantId,
          kind: ref.kind,
          subjectType: ref.subjectType,
          subjectId: ref.subjectId,
        },
      },
      select: { id: true, status: true, externalId: true },
    });
  }

  /**
   * Creates the operation if needed and takes a lease for one attempt. Only
   * one caller wins; a running attempt is left alone until its lease
   * expires, after which the next claim knows the attempt was abandoned.
   */
  async claim(
    ref: OperationRef,
    mode: WriteIdempotency,
    now: Date,
    leaseMs: number,
  ): Promise<ClaimResult> {
    await this.prisma.connectorOperation.createMany({
      data: [
        {
          tenantId: ref.tenantId,
          kind: ref.kind,
          subjectType: ref.subjectType,
          subjectId: ref.subjectId,
          idempotencyKey: ConnectorOperations.keyFor(ref),
        },
      ],
      skipDuplicates: true,
    });
    const row = await this.prisma.connectorOperation.findUniqueOrThrow({
      where: {
        tenantId_kind_subjectType_subjectId: {
          tenantId: ref.tenantId,
          kind: ref.kind,
          subjectType: ref.subjectType,
          subjectId: ref.subjectId,
        },
      },
    });
    const refused = (reason: 'BUSY' | 'NOT_DUE' | 'TERMINAL'): ClaimResult => ({
      claimed: false,
      reason,
      status: row.status,
      externalId: row.externalId,
    });
    if (TERMINAL.has(row.status)) return refused('TERMINAL');
    const abandoned =
      row.status === 'IN_FLIGHT' &&
      row.leaseExpiresAt !== null &&
      row.leaseExpiresAt <= now;
    if (row.status === 'IN_FLIGHT' && !abandoned) return refused('BUSY');
    if (
      row.status === 'RETRY_WAIT' &&
      row.nextAttemptAt !== null &&
      row.nextAttemptAt > now
    )
      return refused('NOT_DUE');
    const leaseToken = randomBytes(16).toString('hex');
    // Compare-and-set on status and attempts: exactly one concurrent claimer wins.
    const won = await this.prisma.connectorOperation.updateMany({
      where: {
        id: row.id,
        tenantId: ref.tenantId,
        status: row.status,
        attempts: row.attempts,
      },
      data: {
        status: 'IN_FLIGHT',
        attempts: { increment: 1 },
        attemptMode: mode,
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        nextAttemptAt: null,
      },
    });
    if (won.count !== 1) return refused('BUSY');
    return {
      claimed: true,
      operation: {
        id: row.id,
        tenantId: ref.tenantId,
        idempotencyKey: row.idempotencyKey,
        leaseToken,
        attempt: row.attempts + 1,
        previous: {
          lastExecution: (row.lastExecution as WriteExecution | null) ?? null,
          abandoned,
          attemptMode: (row.attemptMode as WriteIdempotency | null) ?? null,
        },
      },
    };
  }

  /** Records the outcome of the claimed attempt; false if the lease was lost. */
  async finish(
    tx: Tx,
    op: ClaimedOperation,
    outcome:
      | { status: 'SUCCEEDED'; externalId: string }
      | {
          status: 'RETRY_WAIT';
          nextAttemptAt: Date;
          execution: WriteExecution;
          errorCode: string;
        }
      | {
          status: 'FAILED' | 'UNCERTAIN';
          execution: WriteExecution;
          errorCode: string;
        },
    now: Date,
  ): Promise<boolean> {
    const base = { leaseToken: null, leaseExpiresAt: null };
    const data: Prisma.ConnectorOperationUpdateManyMutationInput =
      outcome.status === 'SUCCEEDED'
        ? {
            ...base,
            status: 'SUCCEEDED',
            externalId: outcome.externalId,
            lastErrorCode: null,
            completedAt: now,
          }
        : outcome.status === 'RETRY_WAIT'
          ? {
              ...base,
              status: 'RETRY_WAIT',
              nextAttemptAt: outcome.nextAttemptAt,
              lastExecution: outcome.execution,
              lastErrorCode: outcome.errorCode,
            }
          : {
              ...base,
              status: outcome.status,
              lastExecution: outcome.execution,
              lastErrorCode: outcome.errorCode,
              completedAt: now,
            };
    const done = await tx.connectorOperation.updateMany({
      where: {
        id: op.id,
        tenantId: op.tenantId,
        status: 'IN_FLIGHT',
        leaseToken: op.leaseToken,
      },
      data,
    });
    return done.count === 1;
  }

  /** IN_FLIGHT operations whose lease has expired (crash or lost result). */
  abandoned(
    kind: string,
    now: Date,
    limit: number,
  ): Promise<
    { id: string; tenantId: string; subjectId: string; attempts: number }[]
  > {
    return this.prisma.connectorOperation.findMany({
      where: { kind, status: 'IN_FLIGHT', leaseExpiresAt: { lte: now } },
      orderBy: { leaseExpiresAt: 'asc' },
      take: limit,
      select: { id: true, tenantId: true, subjectId: true, attempts: true },
    });
  }
}
