import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentConversationService } from '../../agent/agent-conversation.service.js';
import type { BotSchedule } from '../../agent/bot-schedule.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { TelegramAgentPipeline } from './telegram-agent-pipeline.js';
import type { TelegramQueueEvent } from './telegram-processor.js';

interface PipelineInternals {
  hold(...args: unknown[]): Promise<void>;
  claim(...args: unknown[]): Promise<{ kind: 'none'; reason: string }>;
}

/** What a LIVE batch does under this schedule: held (silent) or claimed. */
async function run(
  botSchedule: BotSchedule | undefined,
): Promise<'held' | 'claimed'> {
  const prisma = {
    conversation: {
      findFirst: async () => ({
        channelAccount: { agentMode: 'LIVE', isTestAccount: true },
      }),
    },
    tenant: {
      findFirst: async () => ({
        config: botSchedule ? { botSchedule } : {},
        timezone: 'Asia/Tashkent',
      }),
    },
  } as unknown as PrismaService;
  const settings: Record<string, unknown> = {
    NODE_ENV: 'development',
    LLM_PROVIDER: 'mock',
    LLM_TRUSTED_PROVIDERS: ['mock'],
  };
  const pipeline = new TelegramAgentPipeline(
    prisma,
    {} as AgentConversationService,
    { get: (key: string) => settings[key] } as never,
  );
  const internals = pipeline as unknown as PipelineInternals;
  const hold = vi.spyOn(internals, 'hold').mockResolvedValue(undefined);
  const claim = vi
    .spyOn(internals, 'claim')
    .mockResolvedValue({ kind: 'none', reason: 'schedule test' });
  await pipeline.run({ tenantId: 't' } as TelegramQueueEvent, {
    inboundEventId: 'e',
    conversationId: 'c',
    requestedMode: 'LIVE',
  });
  expect(hold.mock.calls.length + claim.mock.calls.length).toBe(1);
  return hold.mock.calls.length === 1 ? 'held' : 'claimed';
}

const everyDay = [1, 2, 3, 4, 5, 6, 7];
const allDay = { days: everyDay, from: '00:00', to: '23:59' };

describe('the pipeline follows the bot schedule (ADR 089)', () => {
  // Noon in Tashkent, so the window above is open.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T07:00:00Z'));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('answers with no schedule or "always"', async () => {
    expect(await run(undefined)).toBe('claimed');
    expect(await run({ mode: 'always', ...allDay })).toBe('claimed');
  });

  it('stays silent outside its hours, without calling the model', async () => {
    expect(await run({ mode: 'off_hours', ...allDay })).toBe('held');
    expect(await run({ mode: 'work_hours', ...allDay })).toBe('claimed');
  });
});
