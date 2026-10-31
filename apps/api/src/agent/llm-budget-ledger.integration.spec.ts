import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TurnBudget, type BudgetLimits } from '../core/llm/budget.js';
import { LlmError, type LlmProvider } from '../core/llm/llm-provider.js';
import { MeteredLlm, type LlmUsageEntry } from '../core/llm/metered-llm.js';
import { parsePricingConfig } from '../core/llm/pricing.js';
import {
  ScriptedLlmProvider,
  type ScriptStep,
} from '../core/llm/scripted-llm-provider.js';
import { PrismaClient } from '../generated/prisma/client.js';
import {
  RoutingLlmProvider,
  type RoutedCandidate,
} from '../llm/routing/routing-provider.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { LlmBudgetLedger } from './llm-budget-ledger.js';
import { LlmUsageStore } from './llm-usage.store.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Ledger integration tests require agentcore_test');
}

/** Two clients with their own pools stand in for two worker processes. */
const clients = [0, 1].map(
  () =>
    new PrismaClient({
      adapter: createPostgresAdapter(process.env, 'TEST_'),
    }),
);
const [clientA, clientB] = clients;
const workerA = new LlmBudgetLedger(clientA as unknown as PrismaService);
const workerB = new LlmBudgetLedger(clientB as unknown as PrismaService);
const usage = new LlmUsageStore(clientA as unknown as PrismaService);

afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
});

async function tenant(): Promise<string> {
  const row = await clientA.tenant.create({
    data: {
      slug: `ledger-${randomUUID()}`,
      name: 'Ledger fixture',
      defaultLocale: 'uz-Latn',
      supportedLocales: ['uz-Latn'],
      timezone: 'Asia/Tashkent',
      packKey: 'education',
      packVersion: '1',
    },
  });
  return row.id;
}

const UNIT = 1_000;
const CAP = 3_500; // room for exactly three reservations of UNIT

/** Previous UTC month start without month-end overflow. */
function previousUtcMonthStart(reference: Date): Date {
  return new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() - 1, 1),
  );
}

function reserve(
  ledger: LlmBudgetLedger,
  tenantId: string,
  base: string,
  conversationId: string = randomUUID(),
  capNano: number | undefined = CAP,
  worstCaseNano = UNIT,
): ReturnType<LlmBudgetLedger['reserve']> {
  return ledger.reserve({
    tenantId,
    conversationId,
    baseInvocationId: base,
    worstCaseNano,
    worstCaseTokens: 100,
    monthlyCapNano: capNano,
  });
}

function entry(
  tenantId: string,
  over: Partial<LlmUsageEntry> = {},
): LlmUsageEntry {
  return {
    tenantId,
    conversationId: undefined,
    turnKey: 't',
    callIndex: 0,
    purpose: 'respond',
    tier: 'FAST',
    providerId: 'p',
    model: 'm',
    responseId: `r-${randomUUID()}`,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    },
    costNano: 200,
    reservedNano: UNIT,
    usageBasis: 'reported',
    pricingVersion: 'v',
    durationMs: 1,
    attempts: 1,
    outcome: 'end',
    ...over,
  };
}

const granted = (r: { granted: boolean }): boolean => r.granted;

describe('tenant-month reservations (PostgreSQL)', () => {
  it('lets exactly the permitted number of concurrent reservations succeed, across workers and conversations', async () => {
    const tenantId = await tenant();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        reserve(i % 2 === 0 ? workerA : workerB, tenantId, `turn-${i}:0`),
      ),
    );
    expect(results.filter(granted)).toHaveLength(3);
    expect(results.filter((r) => !r.granted)).toEqual(
      Array(7).fill({ granted: false, reason: 'TENANT_MONTHLY_LIMIT' }),
    );
    expect(await workerA.tenantMonthExposureNano(tenantId)).toBe(3 * UNIT);
  });

  it('denies after the cap is reached and admits again only after justified reconciliation', async () => {
    const tenantId = await tenant();
    const first = await reserve(workerA, tenantId, 'a:0');
    await reserve(workerA, tenantId, 'b:0');
    await reserve(workerB, tenantId, 'c:0');
    expect((await reserve(workerB, tenantId, 'd:0')).granted).toBe(false);
    if (!first.granted) throw new Error('unreachable');
    // Provider-reported usage (200) replaces the worst case (1000).
    await workerA.settle(tenantId, first.reservationId, entry(tenantId));
    expect((await reserve(workerB, tenantId, 'e:0')).granted).toBe(true);
    // 200 spent + 2 x 1000 + 1000 = 3200 <= 3500; one more does not fit.
    expect((await reserve(workerA, tenantId, 'f:0')).granted).toBe(false);
    expect(await usage.tenantMonthSpendNano(tenantId)).toBe(200);
  });

  it('keeps confirmed spend and unknown exposure apart', async () => {
    const tenantId = await tenant();
    const conversationId = randomUUID();
    const done = await reserve(workerA, tenantId, 't:0', conversationId);
    const lost = await reserve(workerA, tenantId, 't:1', conversationId);
    if (!done.granted || !lost.granted) throw new Error('unreachable');
    await workerA.settle(
      tenantId,
      done.reservationId,
      entry(tenantId, { conversationId }),
    );
    await workerA.markUnknown(
      tenantId,
      lost.reservationId,
      entry(tenantId, {
        conversationId,
        responseId: 'unknown:t:1:1',
        costNano: 0,
        usageBasis: 'unknown',
        outcome: 'unknown_usage:LLM_TIMEOUT',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
        },
      }),
    );
    expect(await usage.conversationSpendNano(tenantId, conversationId)).toBe(
      200,
    );
    expect(await usage.conversationTokens(tenantId, conversationId)).toBe(15);
    expect(
      await workerA.conversationExposure(tenantId, conversationId),
    ).toEqual({ nano: UNIT, tokens: 100 });
  });

  it('counts repeated timeouts of one call as separate exposure rows', async () => {
    const tenantId = await tenant();
    const conversationId = randomUUID();
    for (let i = 0; i < 3; i++) {
      const r = await reserve(
        workerA,
        tenantId,
        'turn:0',
        conversationId,
        undefined,
      );
      if (!r.granted) throw new Error('unreachable');
      await workerA.markUnknown(
        tenantId,
        r.reservationId,
        entry(tenantId, { responseId: `unknown:turn:0:${i}`, costNano: 0 }),
      );
    }
    expect(
      await workerA.conversationExposure(tenantId, conversationId),
    ).toEqual({ nano: 3 * UNIT, tokens: 300 });
    const rows = await clientA.llmBudgetReservation.findMany({
      where: { tenantId },
      orderBy: { invocationId: 'asc' },
    });
    expect(rows.map((r) => r.invocationId)).toEqual([
      'turn:0#1',
      'turn:0#2',
      'turn:0#3',
    ]);
  });

  it('treats a retried call as a new invocation and keeps the lost one counted', async () => {
    const tenantId = await tenant();
    const conversationId = randomUUID();
    // First delivery: reserves, then the worker dies (no settle).
    await reserve(workerA, tenantId, 'turn:0', conversationId, undefined);
    // Redelivery on another worker re-reserves the same base id.
    const retry = await reserve(
      workerB,
      tenantId,
      'turn:0',
      conversationId,
      undefined,
    );
    if (!retry.granted) throw new Error('unreachable');
    const states = await clientA.llmBudgetReservation.findMany({
      where: { tenantId },
      orderBy: { invocationId: 'asc' },
      select: { invocationId: true, state: true },
    });
    expect(states).toEqual([
      { invocationId: 'turn:0#1', state: 'UNKNOWN' },
      { invocationId: 'turn:0#2', state: 'RESERVED' },
    ]);
    expect(
      await workerA.conversationExposure(tenantId, conversationId),
    ).toEqual({ nano: 2 * UNIT, tokens: 200 });
  });

  it('settles idempotently: the same invocation is never counted twice', async () => {
    const tenantId = await tenant();
    const r = await reserve(workerA, tenantId, 'turn:0');
    if (!r.granted) throw new Error('unreachable');
    const e = entry(tenantId, { responseId: 'same-response' });
    await workerA.settle(tenantId, r.reservationId, e);
    await workerB.settle(tenantId, r.reservationId, e);
    expect(await usage.tenantMonthSpendNano(tenantId)).toBe(200);
    expect(await workerA.tenantMonthExposureNano(tenantId)).toBe(0);
  });

  it('recovers a crashed reservation as unknown exposure, never as free budget', async () => {
    const tenantId = await tenant();
    let now = new Date();
    const crashed = new LlmBudgetLedger(
      clientA as unknown as PrismaService,
    ).configure({ ttlMs: 1_000, clock: () => now });
    await reserve(crashed, tenantId, 'dead:0');
    now = new Date(now.getTime() + 5_000);
    // Any later reservation of the tenant performs the recovery.
    await reserve(crashed, tenantId, 'next:0');
    const rows = await clientA.llmBudgetReservation.findMany({
      where: { tenantId },
      orderBy: { invocationId: 'asc' },
      select: { invocationId: true, state: true },
    });
    expect(rows).toEqual([
      { invocationId: 'dead:0#1', state: 'UNKNOWN' },
      { invocationId: 'next:0#1', state: 'RESERVED' },
    ]);
    expect(await crashed.tenantMonthExposureNano(tenantId, now)).toBe(2 * UNIT);
    // A late completion with reported usage may then replace the worst case.
    const late = rows[0];
    const row = await clientA.llmBudgetReservation.findFirstOrThrow({
      where: { tenantId, invocationId: late.invocationId },
    });
    await crashed.settle(tenantId, row.id, entry(tenantId));
    expect(await crashed.tenantMonthExposureNano(tenantId, now)).toBe(UNIT);
  });

  it('releases only an attempt that certainly was not billed', async () => {
    const tenantId = await tenant();
    const a = await reserve(workerA, tenantId, 'a:0');
    const b = await reserve(workerA, tenantId, 'b:0');
    if (!a.granted || !b.granted) throw new Error('unreachable');
    await workerA.release(tenantId, a.reservationId);
    await workerA.markUnknown(tenantId, b.reservationId, entry(tenantId));
    await workerA.release(tenantId, b.reservationId); // too late: stays counted
    expect(await workerA.tenantMonthExposureNano(tenantId)).toBe(UNIT);
  });

  it('calculates the previous UTC month safely at month boundaries', () => {
    expect(previousUtcMonthStart(new Date('2026-10-31T23:59:59.999Z'))).toEqual(
      new Date('2026-09-01T00:00:00.000Z'),
    );
    expect(previousUtcMonthStart(new Date('2026-03-31T23:59:59.999Z'))).toEqual(
      new Date('2026-02-01T00:00:00.000Z'),
    );
    expect(previousUtcMonthStart(new Date('2027-01-31T23:59:59.999Z'))).toEqual(
      new Date('2026-12-01T00:00:00.000Z'),
    );
  });

  it('does not leak across tenants or months', async () => {
    const one = await tenant();
    const two = await tenant();
    for (let i = 0; i < 3; i++) await reserve(workerA, one, `x:${i}`);
    expect((await reserve(workerA, one, 'x:3')).granted).toBe(false);
    expect((await reserve(workerA, two, 'y:0')).granted).toBe(true);
    // Last month's reservations do not count this month. Normalize to
    // day 1 before changing months so dates such as October 31 cannot
    // overflow into the current month (September has only 30 days).
    const lastMonth = previousUtcMonthStart(new Date());
    const old = new LlmBudgetLedger(
      clientA as unknown as PrismaService,
    ).configure({ clock: () => lastMonth, ttlMs: 10 * 60_000 });
    const three = await tenant();
    for (let i = 0; i < 3; i++) await reserve(old, three, `o:${i}`);
    expect(await workerA.tenantMonthExposureNano(three)).toBe(0);
    expect((await reserve(workerA, three, 'now:0')).granted).toBe(true);
  });

  it('reservations of other tenants and conversations stay out of conversation exposure', async () => {
    const tenantId = await tenant();
    const c1 = randomUUID();
    await reserve(workerA, tenantId, 'p:0', c1, undefined);
    await reserve(workerA, tenantId, 'q:0', randomUUID(), undefined);
    expect(await workerA.conversationExposure(tenantId, c1)).toEqual({
      nano: UNIT,
      tokens: 100,
    });
    expect(await workerA.conversationExposure(await tenant(), c1)).toEqual({
      nano: 0,
      tokens: 0,
    });
  });
});

describe('conversation caps (PostgreSQL)', () => {
  function reserveIn(
    ledger: LlmBudgetLedger,
    tenantId: string,
    conversationId: string,
    base: string,
    caps: { nano?: number; tokens?: number },
  ): ReturnType<LlmBudgetLedger['reserve']> {
    return ledger.reserve({
      tenantId,
      conversationId,
      baseInvocationId: base,
      worstCaseNano: UNIT,
      worstCaseTokens: 100,
      conversationCapNano: caps.nano,
      conversationCapTokens: caps.tokens,
    });
  }

  it('lets exactly the permitted number of concurrent turns of ONE conversation reserve, across workers', async () => {
    const tenantId = await tenant();
    const conversationId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        reserveIn(
          i % 2 === 0 ? workerA : workerB,
          tenantId,
          conversationId,
          `turn-${i}:0`,
          { nano: CAP },
        ),
      ),
    );
    expect(results.filter(granted)).toHaveLength(3);
    expect(results.find((r) => !r.granted)).toEqual({
      granted: false,
      reason: 'CONVERSATION_COST_LIMIT',
    });
  });

  it('counts confirmed spend of the conversation and leaves other conversations independent', async () => {
    const tenantId = await tenant();
    const busy = randomUUID();
    const other = randomUUID();
    const first = await reserveIn(workerA, tenantId, busy, 'a:0', {
      nano: CAP,
    });
    if (!first.granted) throw new Error('unreachable');
    await workerA.settle(
      tenantId,
      first.reservationId,
      entry(tenantId, { conversationId: busy, costNano: 2_000 }),
    );
    // 2000 spent: one more reservation fits (3000), a second (4000) does not.
    expect(
      (await reserveIn(workerB, tenantId, busy, 'b:0', { nano: CAP })).granted,
    ).toBe(true);
    expect(
      (await reserveIn(workerB, tenantId, busy, 'c:0', { nano: CAP })).granted,
    ).toBe(false);
    expect(
      (await reserveIn(workerB, tenantId, other, 'd:0', { nano: CAP })).granted,
    ).toBe(true);
  });

  it('enforces the conversation token cap with unknown exposure included', async () => {
    const tenantId = await tenant();
    const conversationId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        reserveIn(
          i % 2 === 0 ? workerA : workerB,
          tenantId,
          conversationId,
          `t-${i}:0`,
          { tokens: 250 },
        ),
      ),
    );
    expect(results.filter(granted)).toHaveLength(2);
    expect(results.find((r) => !r.granted)).toEqual({
      granted: false,
      reason: 'CONVERSATION_TOKEN_LIMIT',
    });
  });
});

describe('MeteredLlm with the PostgreSQL ledger', () => {
  const snapshot = parsePricingConfig({
    version: 'ledger-fixture-1',
    provider: 't',
    asOf: '2026-01-01',
    sourceUrl: 'https://example.invalid/p',
    models: Object.fromEntries(
      ['pa', 'pb'].map((m) => [
        m,
        {
          inputPerMTok: '1.00',
          outputPerMTok: '2.00',
          cacheReadPerMTok: '0.10',
          cacheWrite5mPerMTok: '1.25',
          cacheWrite1hPerMTok: '2.00',
        },
      ]),
    ),
  });
  const limits: BudgetLimits = {
    maxTurnCostNano: 1e12,
    maxConversationCostNano: 1e12,
    maxCallsPerTurn: 20,
    maxToolRoundsPerTurn: 5,
    maxToolCallsPerTurn: 5,
    maxOutputTokensPerCall: 100,
    maxInputBytesPerCall: 10_000,
  };
  const request = {
    tier: 'FAST' as const,
    purpose: 'respond' as const,
    system: 's',
    messages: [{ role: 'user' as const, text: 'hi' }],
    tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
    maxOutputTokens: 50,
  };
  const timeout: ScriptStep = {
    kind: 'error',
    error: new LlmError('LLM_TIMEOUT', 'x', false),
  };
  const ok: ScriptStep = { kind: 'tools', text: 'ok' };
  const BREAKER = {
    breaker: {
      rateLimitCooldownMs: 60_000,
      providerCooldownMs: 900_000,
      transientCooldownMs: 30_000,
      transientFailures: 5,
    },
  };
  function candidate(
    id: string,
    model: string,
    steps: ScriptStep[],
    holdMs = 0,
  ): RoutedCandidate & { scripted: ScriptedLlmProvider } {
    const scripted = new ScriptedLlmProvider(steps, model);
    // Keeps the call in flight so concurrent turns overlap.
    const provider: LlmProvider = {
      providerId: scripted.providerId,
      modelFor: (tier) => scripted.modelFor(tier),
      generateStructured: (r) => scripted.generateStructured(r),
      generateWithTools: async (r) => {
        await new Promise((done) => setTimeout(done, holdMs));
        return scripted.generateWithTools(r);
      },
    };
    return {
      providerId: id,
      model,
      provider,
      capability: { tools: 'yes', structured: 'json_schema' },
      scripted,
    };
  }
  function metered(
    tenantId: string,
    cands: RoutedCandidate[],
    cap: number | undefined,
    turnKey: string,
    ledger: LlmBudgetLedger = workerA,
    prior: ConstructorParameters<typeof TurnBudget>[1] = {
      conversationSpentNano: 0,
      tenantMonthSpentNano: 0,
    },
    turnLimits: BudgetLimits = limits,
    conversationId: string = randomUUID(),
  ): { llm: MeteredLlm; budget: TurnBudget } {
    const budget = new TurnBudget(
      { ...turnLimits, tenantMonthlyBudgetNano: cap },
      prior,
    );
    const llm = new MeteredLlm(
      new RoutingLlmProvider(
        { FAST: cands, STRONG: cands },
        BREAKER,
        snapshot,
        () => 0,
      ),
      snapshot,
      budget,
      { record: async (): Promise<void> => undefined },
      { tenantId, conversationId, turnKey },
      undefined,
      ledger,
    );
    return { llm, budget };
  }
  /** Worst-case nano of one call, from an uncapped probe. */
  async function unit(): Promise<number> {
    const tenantId = await tenant();
    const { llm, budget } = metered(
      tenantId,
      [candidate('a', 'pa', [ok])],
      undefined,
      'probe',
    );
    await llm.withTools(request);
    expect(budget.snapshot.spentNano).toBeGreaterThan(0);
    const row = await clientA.llmUsageRecord.findFirstOrThrow({
      where: { tenantId },
    });
    return Number(row.reservedNano);
  }

  it('settles a call: usage recorded once, reservation no longer counted', async () => {
    const tenantId = await tenant();
    const { llm } = metered(tenantId, [candidate('a', 'pa', [ok])], 1e9, 'k1');
    await llm.withTools(request);
    expect(await workerA.tenantMonthExposureNano(tenantId)).toBe(0);
    expect(await usage.tenantMonthSpendNano(tenantId)).toBeGreaterThan(0);
    const rows = await clientA.llmBudgetReservation.findMany({
      where: { tenantId },
    });
    expect(rows.map((r) => r.state)).toEqual(['SETTLED']);
  });

  it('fails over after a timeout only if the tenant month can absorb a second reservation', async () => {
    const n = await unit();
    expect(n).toBeGreaterThan(0);
    // Room for one reservation but not two: the timeout stops the call.
    const tight = await tenant();
    const a1 = candidate('a', 'pa', [timeout]);
    const b1 = candidate('b', 'pb', [ok]);
    await expect(
      metered(tight, [a1, b1], Math.floor(n * 1.5), 'k2').llm.withTools(
        request,
      ),
    ).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
    expect(b1.scripted.calls).toHaveLength(0);
    expect(await workerA.tenantMonthExposureNano(tight)).toBe(n);
    // Room for two: failover happens; the lost attempt stays as exposure.
    const roomy = await tenant();
    const a2 = candidate('a', 'pa', [timeout]);
    const b2 = candidate('b', 'pb', [ok]);
    await metered(roomy, [a2, b2], n * 3, 'k3').llm.withTools(request);
    expect(b2.scripted.calls).toHaveLength(1);
    expect(await workerA.tenantMonthExposureNano(roomy)).toBe(n);
    const states = (
      await clientA.llmBudgetReservation.findMany({
        where: { tenantId: roomy },
        orderBy: { invocationId: 'asc' },
      })
    ).map((r) => r.state);
    expect(states).toEqual(['UNKNOWN', 'SETTLED']);
  });

  it('refuses a call when concurrent turns of other conversations hold the month', async () => {
    const n = await unit();
    const tenantId = await tenant();
    // Four simultaneous turns, two per worker, cap for exactly two calls.
    const outcomes = await Promise.allSettled(
      [workerA, workerB, workerA, workerB].map((ledger, i) =>
        metered(
          tenantId,
          [candidate('a', 'pa', [ok], 300)],
          Math.floor(n * 2.5),
          `race-${i}`,
          ledger,
        ).llm.withTools(request),
      ),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
    const refused = outcomes.filter((o) => o.status === 'rejected');
    expect(refused).toHaveLength(2);
    for (const o of refused)
      expect((o as PromiseRejectedResult).reason).toMatchObject({
        reason: 'TENANT_MONTHLY_LIMIT',
      });
  });

  it('refuses overlapping turns of the same conversation beyond its cap, even from different workers', async () => {
    const n = await unit();
    const tenantId = await tenant();
    const conversationId = randomUUID();
    const turn = (ledger: LlmBudgetLedger, i: number): Promise<unknown> => {
      const { llm } = metered(
        tenantId,
        [candidate('a', 'pa', [ok], 300)],
        undefined,
        `same-${i}`,
        ledger,
        { conversationSpentNano: 0, tenantMonthSpentNano: 0 },
        { ...limits, maxConversationCostNano: Math.floor(n * 2.5) },
        conversationId,
      );
      return llm.withTools(request);
    };
    // Both turns loaded "0 spent" before either reserved: only the ledger
    // can stop the overshoot.
    const outcomes = await Promise.allSettled(
      [workerA, workerB, workerA, workerB].map(turn),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
    for (const o of outcomes.filter((x) => x.status === 'rejected'))
      expect((o as PromiseRejectedResult).reason).toMatchObject({
        reason: 'CONVERSATION_COST_LIMIT',
      });
  });

  it('keeps a timed-out attempt counted when the ledger cannot record it', async () => {
    const tenantId = await tenant();
    const failing = Object.create(workerA) as LlmBudgetLedger;
    failing.markUnknown = (): Promise<void> => {
      throw new Error('db down');
    };
    const errors: unknown[] = [];
    const budget = new TurnBudget(limits, {
      conversationSpentNano: 0,
      tenantMonthSpentNano: 0,
    });
    const llm = new MeteredLlm(
      new RoutingLlmProvider(
        {
          FAST: [candidate('a', 'pa', [timeout])],
          STRONG: [candidate('a', 'pa', [timeout])],
        },
        BREAKER,
        snapshot,
        () => 0,
      ),
      snapshot,
      budget,
      { record: async (): Promise<void> => undefined },
      { tenantId, conversationId: randomUUID(), turnKey: 'dbfail' },
      (e) => errors.push(e),
      failing,
    );
    await expect(llm.withTools(request)).rejects.toMatchObject({
      code: 'LLM_TIMEOUT',
    });
    expect(errors).toHaveLength(1);
    // The row stays RESERVED in the database, so it still counts.
    expect(await workerA.tenantMonthExposureNano(tenantId)).toBeGreaterThan(0);
    expect(budget.snapshot.unknownExposureNano).toBeGreaterThan(0);
  });

  it('counts persisted unknown token exposure against the conversation token budget', async () => {
    const tenantId = await tenant();
    const { llm } = metered(
      tenantId,
      [candidate('a', 'pa', [ok])],
      undefined,
      'tok',
      workerA,
      {
        conversationSpentNano: 0,
        tenantMonthSpentNano: 0,
        conversationExposureTokens: 900,
      },
    );
    // limits has no token cap here; assert through a capped budget below.
    await llm.withTools(request);
    const capped = new TurnBudget(
      { ...limits, maxConversationTokens: 1_000 },
      {
        conversationSpentNano: 0,
        tenantMonthSpentNano: 0,
        conversationExposureTokens: 900,
      },
    );
    expect(() => capped.reserve(0, 10, 200)).toThrow(/CONVERSATION_TOKEN/u);
    expect(capped.snapshot.tokensUsed).toBe(0); // exposure is not usage
  });
});
