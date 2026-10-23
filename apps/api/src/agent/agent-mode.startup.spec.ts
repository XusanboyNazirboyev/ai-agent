import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnvironment } from '../config/environment.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { AgentModeStartupCheck } from './agent-mode.startup.js';

function check(
  values: Partial<AppEnvironment>,
  rows: Array<{ id: string }>,
): { run: () => Promise<void>; findMany: ReturnType<typeof vi.fn> } {
  const findMany = vi.fn().mockResolvedValue(rows);
  const startup = new AgentModeStartupCheck(
    { channelAccount: { findMany } } as unknown as PrismaService,
    {
      get: (key: keyof AppEnvironment) => values[key],
    } as unknown as ConfigService<AppEnvironment, true>,
  );
  return { run: () => startup.onApplicationBootstrap(), findMany };
}

const ACCOUNT = '01a16865-91b2-706f-b43f-c098f959afa9';

describe('agent mode startup check', () => {
  it('refuses to start when the served account is LIVE outside development', async () => {
    const { run, findMany } = check(
      { NODE_ENV: 'production', TELEGRAM_CHANNEL_ACCOUNT_ID: ACCOUNT },
      [{ id: ACCOUNT }],
    );
    await expect(run()).rejects.toThrow(/operator handover notifier/);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ACCOUNT, agentMode: 'LIVE', status: 'ACTIVE' },
      }),
    );
  });

  it('starts with LIVE in local development, or when nothing is LIVE', async () => {
    await expect(
      check({ NODE_ENV: 'development', TELEGRAM_CHANNEL_ACCOUNT_ID: ACCOUNT }, [
        { id: ACCOUNT },
      ]).run(),
    ).resolves.toBeUndefined();
    await expect(
      check(
        { NODE_ENV: 'production', TELEGRAM_CHANNEL_ACCOUNT_ID: ACCOUNT },
        [],
      ).run(),
    ).resolves.toBeUndefined();
    const unserved = check({ NODE_ENV: 'production' }, [{ id: ACCOUNT }]);
    await expect(unserved.run()).resolves.toBeUndefined();
    expect(unserved.findMany).not.toHaveBeenCalled();
  });
});
