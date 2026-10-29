import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import {
  setTestAccount,
  TEST_ACCOUNT_ACTOR,
  TEST_ACCOUNT_AUDIT_ACTION,
} from './test-account.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('requires agentcore_test');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
afterAll(async () => db.$disconnect());

async function tenantWithAccount(): Promise<{
  slug: string;
  tenantId: string;
  accountId: string;
}> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `test-account-${suffix}`,
      name: 'Test-account script fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `test-account-${suffix}`,
      agentMode: 'SHADOW',
    },
  });
  return { slug: tenant.slug, tenantId: tenant.id, accountId: account.id };
}

describe('channel:test-account (dev script)', () => {
  it('sets and clears the flag, audits each change once and is idempotent', async () => {
    const a = await tenantWithAccount();
    const on = { tenantSlug: a.slug, accountId: a.accountId, on: true };
    expect(await setTestAccount(db, on)).toMatchObject({
      status: 'changed',
      isTestAccount: true,
      agentMode: 'SHADOW',
    });
    expect(await setTestAccount(db, on)).toMatchObject({
      status: 'unchanged',
    });
    expect(await setTestAccount(db, { ...on, on: false })).toMatchObject({
      status: 'changed',
      isTestAccount: false,
    });
    expect(
      (
        await db.channelAccount.findUniqueOrThrow({
          where: { id: a.accountId },
        })
      ).isTestAccount,
    ).toBe(false);
    const audits = await db.auditEvent.findMany({
      where: { tenantId: a.tenantId, action: TEST_ACCOUNT_AUDIT_ACTION },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((x) => [x.actorType, x.actorId, x.entityId])).toEqual([
      ['SYSTEM', TEST_ACCOUNT_ACTOR, a.accountId],
      ['SYSTEM', TEST_ACCOUNT_ACTOR, a.accountId],
    ]);
    expect(audits.map((x) => x.safeInputSummary)).toEqual([
      { from: false, to: true },
      { from: true, to: false },
    ]);
  });

  it('refuses an account of another tenant and an unknown tenant, changing nothing', async () => {
    const a = await tenantWithAccount();
    const b = await tenantWithAccount();
    for (const args of [
      { tenantSlug: a.slug, accountId: b.accountId, on: true },
      {
        tenantSlug: `missing-${randomUUID()}`,
        accountId: a.accountId,
        on: true,
      },
    ])
      await expect(setTestAccount(db, args)).rejects.toThrow(
        'No such channel account in that tenant',
      );
    const rows = await db.channelAccount.findMany({
      where: { id: { in: [a.accountId, b.accountId] } },
    });
    expect(rows.every((row) => !row.isTestAccount)).toBe(true);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: { in: [a.tenantId, b.tenantId] },
          action: TEST_ACCOUNT_AUDIT_ACTION,
        },
      }),
    ).toBe(0);
  });
});
