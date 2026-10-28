import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { newTraceId, runWithLogContext } from '../observability/log-context.js';
import { HandoverSlaService } from './handover-sla.service.js';

export const SCHEDULED_SCANS = Symbol('SCHEDULED_SCANS');

/** Periodic background scans (lead CRM retries, follow-ups, ...). */
export interface ScheduledScan {
  scanDue(now: Date): Promise<number>;
}

@Injectable()
export class HandoverRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HandoverRuntime.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  readonly scans: ScheduledScan[] = [];

  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly sla: HandoverSlaService,
    @Optional() @Inject(SCHEDULED_SCANS) extra?: ScheduledScan[],
  ) {
    if (extra) this.scans.push(...extra);
  }

  onModuleInit(): void {
    const seconds =
      this.config.get('HANDOVER_SCAN_SECONDS', { infer: true }) ?? 30;
    this.timer = setInterval(() => void this.tick(), seconds * 1_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One scan pass; exposed for tests. Never overlaps itself. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Each pass is one trace (it covers every tenant, so no tenantId).
      await runWithLogContext({ traceId: newTraceId() }, async () => {
        await this.sla.scan(now);
        for (const scan of this.scans) await scan.scanDue(now);
      });
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'handover.scan_failed',
          name: (error as Error).name,
        }),
      );
    } finally {
      this.running = false;
    }
  }
}
