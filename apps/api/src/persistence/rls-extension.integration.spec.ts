import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { withRlsExtension, type RlsClient } from './rls-extension.js';
import {
  RLS_TABLES,
  recordStatements,
  createThrowawayRole,
  dropThrowawayRole,
  newClient,
  removeTenant,
  seedTenant,
  type SeededTenant,
  type ThrowawayRole,
} from './rls-spike-support.js';
import { runAsSystem, runWithTenant } from './tenant-context.js';

loadEnv({ path: resolve(process.cwd(), '../../.env') });

if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('RLS extension tests only run against agentcore_test');
}

const owner = newClient(process.env);
let role: ThrowawayRole;
let appBase: PrismaClient;
let appStrict: RlsClient;
let ownerStrict: RlsClient;
let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  const policies = await owner.$queryRaw<Array<{ tablename: string }>>`
    SELECT DISTINCT tablename::text AS tablename FROM pg_policies
    WHERE schemaname = 'public'`;
  for (const table of RLS_TABLES)
    expect(policies.map((p) => p.tablename)).toContain(table);
  role = await createThrowawayRole(process.env, owner);
  appBase = newClient(process.env, role);
  appStrict = withRlsExtension(appBase, { mode: 'strict' });
  ownerStrict = withRlsExtension(owner, { mode: 'strict' });
  a = await seedTenant(owner, 3);
  b = await seedTenant(owner, 3);
});

afterAll(async () => {
  await appBase?.$disconnect();
  if (a) await removeTenant(owner, a.tenantId);
  if (b) await removeTenant(owner, b.tenantId);
  if (role) await dropThrowawayRole(process.env, owner, role);
  await owner.$disconnect();
});

async function settingNow(client: PrismaClient): Promise<string | null> {
  const [row] = await client.$queryRaw<Array<{ v: string | null }>>`
    SELECT current_setting('app.tenant_id', true) AS v`;
  return row?.v ?? null;
}

describe('RLS Prisma extension spike (ADR 054)', () => {
  it('the throwaway role really is subject to RLS (control)', async () => {
    const rows = await appBase.contact.findMany();
    expect(rows).toHaveLength(0);
  });

  it('(a) strict mode throws without tenant context', async () => {
    await expect(appStrict.contact.findMany()).rejects.toThrow(
      /RLS strict: Contact\.findMany ran with no tenant context/,
    );
  });

  it('(b) with context a read returns only that tenant; foreign ids give null/0', async () => {
    await runWithTenant(a.tenantId, async () => {
      const rows = await appStrict.contact.findMany();
      expect(rows.map((r) => r.id).sort()).toEqual([...a.contactIds].sort());
      expect(
        await appStrict.contact.findUnique({
          where: { id: b.contactIds[0] as string },
        }),
      ).toBeNull();
      expect(
        await appStrict.conversation.count({
          where: { id: { in: b.conversationIds } },
        }),
      ).toBe(0);
      const withInclude = await appStrict.conversation.findMany({
        include: { contact: { select: { name: true } } },
      });
      expect(withInclude).toHaveLength(3);
    });
  });

  it('(c) interactive $transaction sees only its tenant and does not open a nested transaction', async () => {
    const statements = await recordStatements(() =>
      runWithTenant(b.tenantId, () =>
        appStrict.$transaction(async (tx) => {
          const rows = await tx.contact.findMany();
          expect(rows.map((r) => r.id).sort()).toEqual(
            [...b.contactIds].sort(),
          );
          // Calls on `tx` are not wrapped again.
          expect(await tx.message.count()).toBe(3);
          expect(await tx.conversation.count()).toBe(3);
        }),
      ),
    );
    const kinds = statements.map((q) => q.trim().split(/\s+/)[0]);
    expect(kinds.filter((k) => k === 'BEGIN')).toHaveLength(1);
    expect(statements.filter((q) => q.includes('set_config'))).toHaveLength(1);
    expect(statements[1]).toContain('set_config');
  });

  it('batch $transaction([...]) with context is tenant-scoped and returns only the caller results', async () => {
    const result = await runWithTenant(a.tenantId, () =>
      appStrict.$transaction([
        appBase.contact.count(),
        appBase.conversation.count(),
      ]),
    );
    expect(result).toEqual([3, 3]);
  });

  it('(d) the setting never leaks into the pool: 200 alternating operations, 20 in parallel', async () => {
    const leaked: Array<string | null> = [];
    for (let batch = 0; batch < 10; batch++) {
      await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          const tenant = (batch * 20 + i) % 2 === 0 ? a : b;
          const other = tenant === a ? b : a;
          const seen = await runWithTenant(tenant.tenantId, () =>
            appStrict.contact.findMany({ select: { id: true } }),
          );
          expect(seen.map((r) => r.id).sort()).toEqual(
            [...tenant.contactIds].sort(),
          );
          expect(seen.some((r) => other.contactIds.includes(r.id))).toBe(false);
          const value = await settingNow(appBase);
          if (value) leaked.push(value);
        }),
      );
    }
    expect(leaked).toEqual([]);
    // Same after an interactive transaction.
    await runWithTenant(a.tenantId, () =>
      appStrict.$transaction((tx) => tx.contact.count()),
    );
    expect(((await settingNow(appBase)) ?? '') === '').toBe(true);
  });

  it('(e) INSERT for another tenant fails the WITH CHECK', async () => {
    await expect(
      runWithTenant(a.tenantId, () =>
        appStrict.contact.create({
          data: {
            tenantId: b.tenantId,
            channelAccountId: b.channelAccountId,
            providerUserId: `x-${randomUUID()}`,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
    // Own tenant works.
    const ok = await runWithTenant(a.tenantId, () =>
      appStrict.contact.create({
        data: {
          tenantId: a.tenantId,
          channelAccountId: a.channelAccountId,
          providerUserId: `ok-${randomUUID()}`,
        },
      }),
    );
    expect(ok.tenantId).toBe(a.tenantId);
    await owner.contact.delete({ where: { id: ok.id } });
  });

  it('(f) runAsSystem with the owner client works; owner strict without context still throws', async () => {
    const rows = await runAsSystem(() =>
      ownerStrict.contact.findMany({
        where: { tenantId: { in: [a.tenantId, b.tenantId] } },
      }),
    );
    expect(rows).toHaveLength(6);
    await expect(ownerStrict.contact.findMany()).rejects.toThrow(
      /no tenant context/,
    );
  });

  it('off passes through; warn logs once per model+operation and passes through', async () => {
    const off = withRlsExtension(appBase, { mode: 'off' });
    expect(await off.contact.findMany()).toHaveLength(0);
    const messages: string[] = [];
    const warn = withRlsExtension(appBase, {
      mode: 'warn',
      warn: (m) => messages.push(m),
    });
    await warn.contact.findMany();
    await warn.contact.findMany();
    await warn.contact.count();
    expect(messages).toHaveLength(2);
  });

  it('a non-RLS model is never wrapped, even in strict', async () => {
    // The throwaway role has no grant on tenants: the failure must come from
    // Postgres (permission denied), not from the strict-mode guard.
    const error = await appStrict.tenant.findMany({ take: 1 }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/permission denied/i);
    expect(error?.message).not.toMatch(/RLS strict/);
  });

  it('records whether $queryRaw is intercepted by query hooks with this adapter', async () => {
    const seen: string[] = [];
    const probe = appBase.$extends({
      query: {
        $queryRaw({ args, query }) {
          seen.push('$queryRaw');
          return query(args);
        },
        $executeRaw({ args, query }) {
          seen.push('$executeRaw');
          return query(args);
        },
        $allOperations({ operation, args, query }) {
          seen.push(`all:${operation}`);
          return query(args);
        },
      },
    });
    await probe.$queryRaw`SELECT 1 AS one`;
    await probe.$executeRaw`SELECT 1`;
    console.log(`queryRaw hook probe saw: ${JSON.stringify(seen)}`);
    expect(seen).toEqual([
      '$queryRaw',
      'all:$queryRaw',
      '$executeRaw',
      'all:$executeRaw',
    ]);
  });

  it('counts the statements one wrapped single operation sends', async () => {
    const wrapped = await recordStatements(() =>
      runWithTenant(a.tenantId, () => appStrict.contact.count()),
    );
    const plain = await recordStatements(() => appBase.contact.count());
    console.log(
      `STATEMENTS wrapped=${JSON.stringify(wrapped.map((q) => q.slice(0, 32)))} plain=${JSON.stringify(plain.map((q) => q.slice(0, 32)))}`,
    );
    expect(wrapped.length).toBeGreaterThan(plain.length);
    expect(wrapped[1]).toContain('set_config');
  });
});
