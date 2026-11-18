import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { runWithoutTenant } from '../persistence/tenant-context.js';

export interface BusEvent {
  readonly id: string;
  readonly type: string;
  readonly conversationId: string | null;
  readonly handoverId: string | null;
  readonly messageId: string | null;
}

type Listener = (event: BusEvent) => void;

const POLL_MS = 1000;
const BATCH = 500;

/**
 * One poller per process fans the change feed out to every open stream, so
 * database load is one query per tick however many operators are connected
 * (it was one per stream). It runs only while a stream is open. Streams
 * resume from their own cursor via InboxEventsService; the bus only ever
 * carries events newer than its own cursor, in id order.
 */
@Injectable()
export class InboxEventBus implements OnModuleDestroy {
  private readonly listeners = new Map<string, Set<Listener>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private cursor: bigint | undefined;
  private busy = false;
  /** Queries issued; exposed for tests and metrics. */
  polls = 0;

  /** Poll interval; tests may lower it. */
  pollMs = POLL_MS;

  /**
   * RLS plan S7: one poller serves the open streams of every tenant, so it
   * reads on the privileged connection and its timer runs with no tenant
   * (it is first started inside one tenant's request).
   */
  private readonly db: PrismaClient;

  constructor(
    prisma: PrismaService,
    // Optional only so specs can build it by hand; Nest always provides it.
    @Optional() privileged?: PrivilegedDatabase,
  ) {
    this.db = privileged?.db ?? prisma;
  }

  /**
   * Registers a listener and makes sure the bus cursor exists BEFORE
   * returning, so a caller that then reads the database from its own cursor
   * cannot miss an event (anything newer reaches the listener).
   */
  async subscribe(tenantId: string, listener: Listener): Promise<() => void> {
    let set = this.listeners.get(tenantId);
    if (!set) this.listeners.set(tenantId, (set = new Set()));
    set.add(listener);
    if (this.cursor === undefined) {
      const latest = await runWithoutTenant(() =>
        this.db.inboxEvent.findFirst({
          orderBy: { id: 'desc' },
          select: { id: true },
        }),
      );
      this.cursor ??= latest?.id ?? 0n;
    }
    this.ensureRunning();
    return () => {
      const current = this.listeners.get(tenantId);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(tenantId);
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** Listeners of one tenant (tests, metrics). */
  listenerCount(tenantId: string): number {
    return this.listeners.get(tenantId)?.size ?? 0;
  }

  /** Test hook: one poll now. */
  tick(): Promise<void> {
    // Whoever calls it, the poll belongs to no tenant (RLS plan S7).
    return runWithoutTenant(() => this.poll());
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.polls += 1;
      if (this.cursor === undefined) return;
      const tenants = [...this.listeners.keys()];
      const rows = await this.db.inboxEvent.findMany({
        where: { id: { gt: this.cursor }, tenantId: { in: tenants } },
        orderBy: { id: 'asc' },
        take: BATCH,
      });
      // Advance past rows of tenants nobody listens to as well.
      const newest = await this.db.inboxEvent.findFirst({
        where: { id: { gt: this.cursor } },
        orderBy: { id: 'desc' },
        select: { id: true },
      });
      for (const row of rows) {
        const event: BusEvent = {
          id: row.id.toString(),
          type: row.type,
          conversationId: row.conversationId,
          handoverId: row.handoverId,
          messageId: row.messageId,
        };
        for (const listener of this.listeners.get(row.tenantId) ?? []) {
          try {
            listener(event);
          } catch {
            // One broken stream must not stop the others.
          }
        }
      }
      this.cursor =
        rows.length === BATCH
          ? rows[rows.length - 1].id
          : (newest?.id ?? this.cursor);
    } catch {
      // Retried on the next tick; streams keep their cursors.
    } finally {
      this.busy = false;
    }
  }

  private ensureRunning(): void {
    if (this.timer) return;
    this.timer = runWithoutTenant(() =>
      setInterval(() => void this.tick(), this.pollMs),
    );
    this.timer.unref();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.cursor = undefined;
  }

  onModuleDestroy(): void {
    this.stop();
    this.listeners.clear();
  }
}
