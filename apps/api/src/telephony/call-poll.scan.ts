import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  callAnalysisMinutesOf,
  openPlanLimits,
} from '../access/plan-limits.js';
import { monthStartInZone } from '../access/lead-limit.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { ScheduledScan } from '../handover/handover-runtime.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { runWithTenant } from '../persistence/tenant-context.js';
import { SECRET_CIPHER } from '../secrets/channel-secret-store.js';
import type { SecretCipher } from '../secrets/secret-cipher.js';
import {
  ONLINEPBX_MAX_WINDOW_SECONDS,
  ONLINEPBX_TRANSPORT,
  OnlinePbxClient,
  OnlinePbxError,
  type OnlinePbxSession,
  type OnlinePbxTransport,
} from './onlinepbx-client.js';
import { openTelephonyApiKey } from './telephony-key.js';

export const CALL_POLL_EVERY_MS = 5 * 60 * 1000;
/** Calls can appear up to a minute after they end (OnlinePBX spec); re-read a little. */
export const CALL_POLL_OVERLAP_MS = 2 * 60 * 1000;

const minutesOf = (talkSeconds: number): number => Math.ceil(talkSeconds / 60);

/**
 * ADR 085 step 2: reads the answered calls of every connected PBX into
 * `call_recordings`. Idempotent by (tenant, account, provider call id), so an
 * overlap or a second API process only skips duplicates. A call that would
 * pass the plan's monthly minutes is stored as SKIPPED_LIMIT and never
 * downloaded. Log lines carry codes and counts only.
 */
@Injectable()
export class CallPollScan implements ScheduledScan {
  private readonly logger = new Logger(CallPollScan.name);
  private readonly crossTenant: PrismaClient;
  /** OnlinePBX asks clients not to re-authenticate often; one session per account. */
  private readonly sessions = new Map<string, OnlinePbxSession>();
  private lastRun = 0;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() privileged?: PrivilegedDatabase,
    @Optional() @Inject(SECRET_CIPHER) private readonly cipher?: SecretCipher,
    @Optional()
    @Inject(ONLINEPBX_TRANSPORT)
    private readonly transport?: OnlinePbxTransport | null,
  ) {
    this.crossTenant = privileged?.db ?? prisma;
  }

  async scanDue(now: Date): Promise<number> {
    if (!this.cipher) return 0;
    if (now.getTime() - this.lastRun < CALL_POLL_EVERY_MS) return 0;
    this.lastRun = now.getTime();
    const accounts = await this.crossTenant.telephonyAccount.findMany({
      where: { enabled: true, apiKeyCipher: { not: null } },
      select: { id: true, tenantId: true },
      take: 500,
    });
    let stored = 0;
    for (const account of accounts) {
      try {
        stored += await runWithTenant(account.tenantId, () =>
          this.pollOne(account.tenantId, account.id, now),
        );
      } catch (error: unknown) {
        // One PBX never stops the others.
        this.logger.warn(
          JSON.stringify({
            event: 'telephony.poll_failed',
            code: error instanceof Error ? error.name : 'UNKNOWN',
          }),
        );
      }
    }
    return stored;
  }

  /** Reads one account's window; returns how many new calls were stored. */
  async pollOne(
    tenantId: string,
    accountId: string,
    now: Date,
  ): Promise<number> {
    const row = await this.prisma.telephonyAccount.findFirst({
      where: { id: accountId, tenantId, enabled: true },
      include: { tenant: { select: { timezone: true } } },
    });
    const apiKey = row ? openTelephonyApiKey(this.cipher!, row) : undefined;
    if (!row || !apiKey) return 0;
    const limit = callAnalysisMinutesOf(
      await openPlanLimits(this.prisma, tenantId),
    );
    if (limit <= 0) return 0;

    const fromMs =
      (row.polledUntil ?? row.updatedAt).getTime() - CALL_POLL_OVERLAP_MS;
    // A long outage catches up a week per run, oldest first.
    const toMs = Math.min(
      now.getTime(),
      fromMs + ONLINEPBX_MAX_WINDOW_SECONDS * 1000,
    );
    const client = new OnlinePbxClient({
      domain: row.domain,
      apiKey,
      ...(this.transport ? { transport: this.transport } : {}),
      ...(this.sessions.has(row.id)
        ? { session: this.sessions.get(row.id)! }
        : {}),
    });
    let calls;
    try {
      calls = await client.answeredCalls(
        Math.floor(fromMs / 1000),
        Math.floor(toMs / 1000),
      );
    } catch (error: unknown) {
      if (!(error instanceof OnlinePbxError)) throw error;
      this.sessions.delete(row.id);
      await this.prisma.telephonyAccount.update({
        where: { id: row.id },
        data: { lastError: error.code },
      });
      this.logger.warn(
        JSON.stringify({ event: 'telephony.poll_refused', code: error.code }),
      );
      return 0;
    }
    if (client.session) this.sessions.set(row.id, client.session);

    const known = new Set(
      (
        await this.prisma.callRecording.findMany({
          where: {
            tenantId,
            telephonyAccountId: row.id,
            providerCallId: { in: calls.map((call) => call.uuid) },
          },
          select: { providerCallId: true },
        })
      ).map((call) => call.providerCallId),
    );
    const fresh = calls
      .filter((call) => !known.has(call.uuid))
      .sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime());
    let used = (
      await this.prisma.callRecording.findMany({
        where: {
          tenantId,
          status: { in: ['PENDING', 'ANALYSED'] },
          startedAt: { gte: monthStartInZone(now, row.tenant.timezone) },
        },
        select: { talkSeconds: true },
      })
    ).reduce((sum, call) => sum + minutesOf(call.talkSeconds), 0);

    const data = fresh.map((call) => {
      const minutes = minutesOf(call.talkSeconds);
      const fits = used + minutes <= limit;
      if (fits) used += minutes;
      const outbound = call.direction === 'outbound';
      return {
        tenantId,
        telephonyAccountId: row.id,
        providerCallId: call.uuid,
        direction: call.direction.slice(0, 20),
        customerPhone: (outbound
          ? call.destinationNumber
          : call.callerNumber
        ).slice(0, 40),
        internalNumber: (outbound
          ? call.callerNumber
          : call.destinationNumber
        ).slice(0, 40),
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        talkSeconds: call.talkSeconds,
        status: fits ? ('PENDING' as const) : ('SKIPPED_LIMIT' as const),
      };
    });
    const { count } = await this.prisma.callRecording.createMany({
      data,
      skipDuplicates: true,
    });
    await this.prisma.telephonyAccount.update({
      where: { id: row.id },
      data: { polledUntil: new Date(toMs), lastError: null },
    });
    if (count > 0)
      this.logger.log(
        JSON.stringify({
          event: 'telephony.calls_stored',
          stored: count,
          skippedLimit: data.filter((d) => d.status === 'SKIPPED_LIMIT').length,
        }),
      );
    return count;
  }
}
