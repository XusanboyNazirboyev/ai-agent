import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppEnvironment } from '../config/environment.js';
import type { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { ownerClient } from '../persistence/testing/test-clients.js';
import { PublicPlansController } from './public-plans.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Public plans tests require agentcore_test');
}
const db = ownerClient();
const made: string[] = [];
afterAll(async () => {
  await db.subscriptionPlan.deleteMany({ where: { id: { in: made } } });
  await db.$disconnect();
});

const config = (
  values: Record<string, unknown> = {},
): ConfigService<AppEnvironment, true> =>
  ({ get: (key: string) => values[key] }) as never;
const request = { headers: {}, socket: { remoteAddress: '203.0.113.9' } };

async function plan(
  data: { isPublic: boolean; isActive: boolean; position: number },
  limits: Record<string, number> = {},
): Promise<string> {
  const code = `pp-${randomUUID()}`;
  const row = await db.subscriptionPlan.create({
    data: {
      code,
      name: `Plan ${code}`,
      priceMinor: 12_345_600n,
      currency: 'UZS',
      periodDays: 30,
      limits,
      ...data,
    },
  });
  made.push(row.id);
  return code;
}

describe('GET /api/v1/public/plans', () => {
  it('lists active public plans by position, public limit keys only', async () => {
    const second = await plan(
      { isPublic: true, isActive: true, position: 9_002 },
      { monthlyNewLeads: 1000, maxOperators: 5 },
    );
    const first = await plan(
      { isPublic: true, isActive: true, position: 9_001 },
      {
        monthlyNewLeads: 500,
        maxChannelAccounts: 2,
        monthlyLlmBudgetUsd: 77,
      },
    );
    const hidden = await plan({
      isPublic: false,
      isActive: true,
      position: 9_000,
    });
    const inactive = await plan({
      isPublic: true,
      isActive: false,
      position: 9_000,
    });
    const controller = new PublicPlansController(
      { db } as unknown as PrivilegedDatabase,
      config({ PUBLIC_SALES_CONTACT_URL: 'https://t.me/example' }),
    );
    const body = await controller.plans(request);
    const codes = body.plans.map((p) => p.code);
    expect(codes).not.toContain(hidden);
    expect(codes).not.toContain(inactive);
    expect(codes.indexOf(first)).toBeGreaterThanOrEqual(0);
    expect(codes.indexOf(first)).toBeLessThan(codes.indexOf(second));
    const one = body.plans.find((p) => p.code === first)!;
    expect(one).toMatchObject({
      priceMinor: '12345600',
      currency: 'UZS',
      periodDays: 30,
      limits: { monthlyNewLeads: 500, maxChannelAccounts: 2 },
    });
    expect(JSON.stringify(body)).not.toContain('monthlyLlmBudgetUsd');
    expect(Object.keys(one).sort()).toEqual([
      'code',
      'currency',
      'limits',
      'name',
      'periodDays',
      'priceMinor',
    ]);
    expect(body.contactUrl).toBe('https://t.me/example');
  });

  it('caches for a minute and rate limits per address', async () => {
    const controller = new PublicPlansController(
      { db } as unknown as PrivilegedDatabase,
      config(),
    );
    const first = await controller.plans(request);
    const late = await plan({
      isPublic: true,
      isActive: true,
      position: 9_100,
    });
    const second = await controller.plans(request);
    expect(second.plans.map((p) => p.code)).not.toContain(late);
    expect(second).toBe(first);
    expect(first.contactUrl).toBeNull();
    let error: unknown;
    for (let i = 0; i < 70; i += 1)
      await controller.plans(request).catch((e: unknown) => (error = e));
    expect((error as { getStatus(): number }).getStatus()).toBe(429);
  });
});
