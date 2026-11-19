import { Injectable, Logger } from '@nestjs/common';
import type { ScheduledScan } from '../handover/handover-runtime.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Signups that expired (or were refused) longer ago than this are deleted. */
export const SIGNUP_KEEP_DAYS = 7;
export const SIGNUP_PURGE_BATCH = 500;
const RUN_EVERY_MS = 60 * 60 * 1000;

/**
 * ADR 080: removes self-serve signups that were never confirmed and expired
 * more than a week ago (they hold an e-mail, a password hash and Telegram
 * ids for nothing). CONFIRMED rows stay (they record which tenant a signup
 * created). The one-trial-per-person rule lives in `trial_claims`, which this
 * never touches. Platform table without tenant_id, so it uses the privileged
 * connection. Batched; the log line carries a count only.
 */
@Injectable()
export class SignupCleanupScan implements ScheduledScan {
  private readonly logger = new Logger(SignupCleanupScan.name);
  private lastRun = 0;

  constructor(private readonly privileged: PrivilegedDatabase) {}

  async scanDue(now: Date): Promise<number> {
    if (now.getTime() - this.lastRun < RUN_EVERY_MS) return 0;
    this.lastRun = now.getTime();
    const cutoff = new Date(now.getTime() - SIGNUP_KEEP_DAYS * DAY_MS);
    const db = this.privileged.db;
    const rows = await db.pendingSignup.findMany({
      where: { status: { not: 'CONFIRMED' }, expiresAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: SIGNUP_PURGE_BATCH,
    });
    if (rows.length === 0) return 0;
    const { count } = await db.pendingSignup.deleteMany({
      where: {
        id: { in: rows.map((row) => row.id) },
        status: { not: 'CONFIRMED' },
        expiresAt: { lt: cutoff },
      },
    });
    if (count > 0)
      this.logger.log(
        JSON.stringify({ event: 'signup.purge_expired', deleted: count }),
      );
    // A full batch means more may wait; the next hourly run continues.
    return count;
  }
}
