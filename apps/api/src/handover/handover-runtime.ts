import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { HandoverSlaService } from './handover-sla.service.js';

/** Periodic background scans (SLA alerts; lead retries register here too). */
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
    @Optional() lead?: ScheduledScan,
  ) {
    if (lead) this.scans.push(lead);
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
      await this.sla.scan(now);
      for (const scan of this.scans) await scan.scanDue(now);
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
