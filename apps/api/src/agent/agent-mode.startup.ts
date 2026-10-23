import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { agentModePolicy, assertAgentModeAllowed } from './agent-mode.js';

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
    const get = <K extends keyof AppEnvironment>(key: K): AppEnvironment[K] =>
      this.config.get(key, { infer: true });
    const policy = agentModePolicy({
      NODE_ENV: get('NODE_ENV'),
      LLM_PROVIDER: get('LLM_PROVIDER'),
      LLM_TRUSTED_PROVIDERS: get('LLM_TRUSTED_PROVIDERS'),
      LLM_ALLOW_REAL_CUSTOMER_DATA: get('LLM_ALLOW_REAL_CUSTOMER_DATA'),
    });
    if (!policy.providerTrusted) {
      this.logger.warn(
        JSON.stringify({
          event: 'llm.untrusted_provider',
          provider: get('LLM_PROVIDER'),
          allowRealCustomerData: policy.allowRealCustomerData,
          note: 'free tiers may use prompts to improve their products; use fake or seed data only',
        }),
      );
    }
    const served = get('TELEGRAM_CHANNEL_ACCOUNT_ID');
    if (!served) return;
    const account = await this.prisma.channelAccount.findFirst({
      where: { id: served, status: 'ACTIVE' },
      select: { id: true, agentMode: true, isTestAccount: true },
    });
    if (!account || account.agentMode === 'OFF') return;
    // Throws AgentModeRefusedError: the API does not start in a mode it
    // would refuse to run.
    assertAgentModeAllowed(account.agentMode, policy, account);
    if (account.agentMode === 'LIVE') {
      this.logger.warn(
        JSON.stringify({
          event: 'agent.live_mode_development_only',
          channelAccount: account.id,
          note: 'LIVE without operator notification; local development only',
        }),
      );
    }
    if (
      !policy.providerTrusted &&
      !account.isTestAccount &&
      policy.allowRealCustomerData
    ) {
      this.logger.warn(
        JSON.stringify({
          event: 'llm.real_customer_data_override',
          channelAccount: account.id,
          provider: get('LLM_PROVIDER'),
        }),
      );
    }
  }
}
