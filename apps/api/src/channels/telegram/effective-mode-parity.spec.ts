import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConversationService } from '../../agent/agent-conversation.service.js';
import type {
  AgentModeValue,
  EffectiveAgentMode,
} from '../../agent/agent-mode.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import {
  policyFrom,
  summarizeChannel,
  type ChannelRow,
} from '../../webinbox/channel-summary.js';
import { TelegramAgentPipeline } from './telegram-agent-pipeline.js';
import type { TelegramQueueEvent } from './telegram-processor.js';

/**
 * The AI bot page shows `effectiveMode` from the channel summary. This test
 * runs the real pipeline entry point for every mode, policy and account
 * combination, both built from the same configuration object, and fails
 * when what the pipeline does differs from what the page shows: HOLD only
 * through `hold` (never a claimed turn), SHADOW or LIVE only as the mode of
 * a claimed turn, OFF as neither.
 */
interface PipelineInternals {
  hold(...args: unknown[]): Promise<void>;
  claim(...args: unknown[]): Promise<{ kind: 'none'; reason: string }>;
}

const MODES: AgentModeValue[] = ['OFF', 'SHADOW', 'LIVE'];
const CASES = MODES.flatMap((mode) =>
  (['development', 'test', 'production'] as const).flatMap((nodeEnv) =>
    [true, false].flatMap((trusted) =>
      [true, false].flatMap((allowRealCustomerData) =>
        [true, false].map((isTestAccount) => ({
          mode,
          nodeEnv,
          trusted,
          allowRealCustomerData,
          isTestAccount,
        })),
      ),
    ),
  ),
);
type Case = (typeof CASES)[number];

afterEach(() => vi.restoreAllMocks());

function rowFor(c: Case): ChannelRow {
  return {
    id: 'account-parity',
    channelType: 'telegram',
    displayName: null,
    status: 'ACTIVE',
    agentMode: c.mode,
    isTestAccount: c.isTestAccount,
    operatorChatId: null,
    createdAt: new Date(0),
  };
}

function configFor(c: Case): never {
  const settings: Record<string, unknown> = {
    NODE_ENV: c.nodeEnv,
    LLM_PROVIDER: c.trusted ? 'mock' : 'openai-compatible',
    LLM_TRUSTED_PROVIDERS: ['mock'],
    LLM_ALLOW_REAL_CUSTOMER_DATA: c.allowRealCustomerData,
  };
  return { get: (key: string) => settings[key] } as never;
}

/** What the real pipeline does with one batch for this case. */
async function pipelineApplies(c: Case): Promise<EffectiveAgentMode> {
  const prisma = {
    conversation: {
      findFirst: async () => ({
        channelAccount: { agentMode: c.mode, isTestAccount: c.isTestAccount },
      }),
    },
  } as unknown as PrismaService;
  const pipeline = new TelegramAgentPipeline(
    prisma,
    {} as AgentConversationService,
    configFor(c),
  );
  const internals = pipeline as unknown as PipelineInternals;
  const hold = vi.spyOn(internals, 'hold').mockResolvedValue(undefined);
  const claim = vi
    .spyOn(internals, 'claim')
    .mockResolvedValue({ kind: 'none', reason: 'parity test' });
  await pipeline.run({ tenantId: 'tenant-parity' } as TelegramQueueEvent, {
    inboundEventId: 'event-parity',
    conversationId: 'conversation-parity',
    requestedMode: c.mode,
  });
  expect(hold.mock.calls.length + claim.mock.calls.length).toBeLessThanOrEqual(
    1,
  );
  if (hold.mock.calls.length === 1) return 'HOLD';
  if (claim.mock.calls.length === 0) return 'OFF';
  const claimedMode = claim.mock.calls[0]?.[3];
  // A claimed turn calls the model; only SHADOW and LIVE may do that.
  expect(['SHADOW', 'LIVE']).toContain(claimedMode);
  return claimedMode as EffectiveAgentMode;
}

describe('AI bot page and pipeline agree on the effective mode', () => {
  it.each(CASES)(
    '$mode, $nodeEnv, trusted=$trusted, allowReal=$allowRealCustomerData, test=$isTestAccount',
    async (c) => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const summary = summarizeChannel(
        rowFor(c),
        policyFrom(configFor(c)),
        'ui',
      );
      expect(await pipelineApplies(c)).toBe(summary.effectiveMode);
    },
  );

  it('the cases cover every effective mode, including both degradations', () => {
    const shown = new Set(
      CASES.map(
        (c) =>
          summarizeChannel(rowFor(c), policyFrom(configFor(c)), 'ui')
            .effectiveMode,
      ),
    );
    expect([...shown].sort()).toEqual(['HOLD', 'LIVE', 'OFF', 'SHADOW']);
  });
});
