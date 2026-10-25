import { config as loadEnv } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadLifecycleCases } from '../agent/testing/lifecycle-cases.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import {
  runLifecycleCase,
  type LifecycleOutcome,
} from './testing/lifecycle-runner.js';

/**
 * Action-lifecycle evaluation (Phase 7.2): every case runs on the real
 * pipeline with a scripted CRM. Blocking: every expectation, and ZERO false
 * success claims across all customer messages of all cases.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('requires agentcore_test');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const cases = loadLifecycleCases(
  resolve(process.cwd(), '../../eval/lifecycle'),
);
const outcomes: LifecycleOutcome[] = [];

afterAll(async () => {
  const falseClaims = outcomes.reduce(
    (sum, o) => sum + o.falseSuccessClaims,
    0,
  );
  const summary = {
    suite: 'action-lifecycle',
    cases: outcomes.length,
    passed: outcomes.filter((o) => o.failures.length === 0).length,
    falseSuccessClaims: falseClaims,
    crmCalls: outcomes.reduce((sum, o) => sum + o.crmCalls, 0),
  };
  mkdirSync(resolve(process.cwd(), '../../eval/reports'), { recursive: true });
  writeFileSync(
    resolve(process.cwd(), '../../eval/reports/lifecycle-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(
    `EVAL lifecycle: ${summary.passed}/${summary.cases} passed, false success claims = ${falseClaims}`,
  );
  await db.$disconnect();
});

describe('action lifecycle evaluation', () => {
  it('has cases for both packs and every launch locale', () => {
    const keys = new Set(cases.map((c) => `${c.pack}/${c.locale}`));
    for (const pack of ['education', 'travel'])
      for (const locale of ['uz-Latn', 'uz-Cyrl', 'ru', 'en'])
        expect(keys.has(`${pack}/${locale}`), `${pack}/${locale}`).toBe(true);
  });

  it.each(cases.map((item) => [item.id, item] as const))(
    '%s',
    async (_id, item) => {
      const outcome = await runLifecycleCase(db, item);
      outcomes.push(outcome);
      expect(outcome.failures).toEqual([]);
    },
  );

  it('gate: zero false success claims across the suite', () => {
    expect(outcomes.reduce((sum, o) => sum + o.falseSuccessClaims, 0)).toBe(0);
  });
});
