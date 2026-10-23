import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnvironment } from '../config/environment.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { AgentModeStartupCheck } from './agent-mode.startup.js';

const ACCOUNT = '01a16865-91b2-706f-b43f-c098f959afa9';

function check(
  values: Partial<AppEnvironment>,
  row: { agentMode: string; isTestAccount: boolean } | null,
): { run: () => Promise<void>; findFirst: ReturnType<typeof vi.fn> } {
  const findFirst = vi
    .fn()
    .mockResolvedValue(row ? { id: ACCOUNT, ...row } : null);
  const settings: Partial<AppEnvironment> = {
    NODE_ENV: 'production',
    LLM_PROVIDER: 'mock',
    LLM_TRUSTED_PROVIDERS: ['mock'],
    LLM_ALLOW_REAL_CUSTOMER_DATA: false,
    TELEGRAM_CHANNEL_ACCOUNT_ID: ACCOUNT,
    ...values,
  };
  const startup = new AgentModeStartupCheck(
    { channelAccount: { findFirst } } as unknown as PrismaService,
    {
      get: (key: keyof AppEnvironment) => settings[key],
    } as unknown as ConfigService<AppEnvironment, true>,
  );
  return { run: () => startup.onApplicationBootstrap(), findFirst };
}

describe('agent mode startup check', () => {
  it('refuses to start when the served account is LIVE outside development', async () => {
    const { run, findFirst } = check(
      {},
      {
        agentMode: 'LIVE',
        isTestAccount: false,
      },
    );
    await expect(run()).rejects.toThrow(/operator handover notifier/);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ACCOUNT, status: 'ACTIVE' } }),
    );
  });

  it('starts with LIVE in local development, with SHADOW, or when unserved', async () => {
    await expect(
      check(
        { NODE_ENV: 'development' },
        {
          agentMode: 'LIVE',
          isTestAccount: false,
        },
      ).run(),
    ).resolves.toBeUndefined();
    await expect(
      check({}, { agentMode: 'SHADOW', isTestAccount: false }).run(),
    ).resolves.toBeUndefined();
    const unserved = check(
      { TELEGRAM_CHANNEL_ACCOUNT_ID: undefined },
      { agentMode: 'LIVE', isTestAccount: false },
    );
    await expect(unserved.run()).resolves.toBeUndefined();
    expect(unserved.findFirst).not.toHaveBeenCalled();
  });

  it('refuses SHADOW on a real account with an untrusted provider unless overridden', async () => {
    const untrusted = { LLM_PROVIDER: 'openai-compatible' as const };
    await expect(
      check(untrusted, { agentMode: 'SHADOW', isTestAccount: false }).run(),
    ).rejects.toThrow(/LLM_ALLOW_REAL_CUSTOMER_DATA/);
    await expect(
      check(untrusted, { agentMode: 'SHADOW', isTestAccount: true }).run(),
    ).resolves.toBeUndefined();
    await expect(
      check(
        { ...untrusted, LLM_ALLOW_REAL_CUSTOMER_DATA: true },
        { agentMode: 'SHADOW', isTestAccount: false },
      ).run(),
    ).resolves.toBeUndefined();
    await expect(
      check(
        {
          ...untrusted,
          NODE_ENV: 'development',
          LLM_ALLOW_REAL_CUSTOMER_DATA: true,
        },
        { agentMode: 'LIVE', isTestAccount: true },
      ).run(),
    ).rejects.toThrow(/untrusted/);
  });
});
