import { describe, expect, it } from 'vitest';
import {
  handoverSummary,
  turnMetrics,
} from '../channels/telegram/telegram-agent-pipeline.js';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import type { ComputedTurn } from './agent-conversation.service.js';
import { DiagnosticsPurgeService } from './diagnostics-purge.service.js';
import { extraction, runTurn } from './testing/agent-harness.js';
import { countBlockedNumberClasses } from './testing/simulation/grader.js';

async function blockedTurn(diagnostics: boolean): Promise<ComputedTurn> {
  const { result, usage } = await runTurn({
    provider: new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'price'),
      { kind: 'tools', text: 'Narxi 99 USD, tel +998 90 123 45 67' },
      { kind: 'tools', text: 'Narxi 99 USD' },
    ]),
    text: 'IELTS narxi?',
    diagnostics,
  });
  return {
    result,
    slotsBefore: {},
    usage,
    latencyMs: 1,
    providerId: 'scripted',
    pricingVersion: 'test',
    promptVersion: 'test',
    packRef: 'education@1',
    timedOut: false,
    ...(result.diagnostics
      ? { diagnosticsExpiresAt: new Date('2026-11-10T00:00:00Z') }
      : {}),
  };
}

describe('diagnostics persistence (ADR 029)', () => {
  it('stores diagnostics with their expiry only when they exist', async () => {
    const on = turnMetrics(await blockedTurn(true));
    expect(on.diagnosticsExpiresAt).toEqual(new Date('2026-11-10T00:00:00Z'));
    expect(JSON.stringify(on.diagnostics)).toContain('UNSOURCED_NUMBER');
    expect(JSON.stringify(on.diagnostics)).not.toMatch(/90 123 45 67/u);
    const off = turnMetrics(await blockedTurn(false));
    expect(off).not.toHaveProperty('diagnostics');
    expect(off).not.toHaveProperty('diagnosticsExpiresAt');
  });

  it('never puts the blocked draft or its numbers into the operator summary', async () => {
    const summary = JSON.stringify(handoverSummary(await blockedTurn(true)));
    expect(summary).not.toContain('Narxi 99');
    expect(summary).not.toContain('draftRedacted');
    expect(summary).not.toContain('blockedDrafts');
  });

  it('clears only expired diagnostics (fixed clock)', async () => {
    const calls: unknown[] = [];
    const prisma = {
      agentTurn: {
        updateMany: (args: unknown): Promise<{ count: number }> => {
          calls.push(args);
          return Promise.resolve({ count: 3 });
        },
      },
    } as unknown as PrismaService;
    const now = new Date('2026-11-10T00:00:00Z');
    await expect(
      new DiagnosticsPurgeService(prisma).scanDue(now),
    ).resolves.toBe(3);
    expect(calls).toEqual([
      {
        where: { diagnosticsExpiresAt: { lte: now } },
        data: { diagnostics: Prisma.DbNull, diagnosticsExpiresAt: null },
      },
    ]);
  });

  it('counts flagged-number classes per run for the baseline ledger', () => {
    expect(
      countBlockedNumberClasses([
        { diagnostics: null },
        {
          diagnostics: {
            blockedDrafts: [
              { tokens: [{ class: 'time' }, { class: 'price' }] },
              { tokens: [{ class: 'time' }] },
            ],
          },
        },
      ]),
    ).toEqual({ time: 2, price: 1 });
  });
});
