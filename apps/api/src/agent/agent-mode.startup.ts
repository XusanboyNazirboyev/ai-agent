import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  AgentModeRefusedError,
  DEFAULT_AGENT_MODE_POLICY,
  liveModeRefusal,
} from './agent-mode.js';

/**
 * Refuses to start while the channel account this process serves
 * (TELEGRAM_CHANNEL_ACCOUNT_ID; Phase 2 runs one bot per process) is LIVE
 * and LIVE is not allowed (no operator notifier outside local development).
 * Any LIVE row, served or not, is also degraded to SHADOW when processed.
 */
@Injectable()
export class AgentModeStartupCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentModeStartupCheck.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const served = this.config.get('TELEGRAM_CHANNEL_ACCOUNT_ID', {
      infer: true,
    });
    if (!served) return;
    const live = await this.prisma.channelAccount.findMany({
      where: { id: served, agentMode: 'LIVE', status: 'ACTIVE' },
      select: { id: true },
    });
    if (live.length === 0) return;
    const refusal = liveModeRefusal(
      DEFAULT_AGENT_MODE_POLICY(this.config.get('NODE_ENV', { infer: true })),
    );
    if (refusal) {
      throw new AgentModeRefusedError(
        `${refusal} Channel accounts in LIVE mode: ${live.map((row) => row.id).join(', ')}`,
      );
    }
    this.logger.warn(
      JSON.stringify({
        event: 'agent.live_mode_development_only',
        channelAccounts: live.map((row) => row.id),
        note: 'LIVE without operator notification; local development only',
      }),
    );
  }
}
