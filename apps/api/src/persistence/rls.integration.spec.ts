import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from './postgres-adapter.js';

loadEnv({ path: resolve(process.cwd(), '../../.env') });

const testDatabase = process.env.TEST_POSTGRES_DATABASE;
if (testDatabase !== 'agentcore_test') {
  throw new Error('RLS integration tests only run against agentcore_test');
}

const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});

afterAll(async () => {
  await db.$disconnect();
});

function unique(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

async function ensureRlsMigration(): Promise<void> {
  const sql = readFileSync(
    resolve(
      process.cwd(),
      'prisma/migrations/20261117090000_rls_high_risk_tables/migration.sql',
    ),
    'utf8',
  );
  await db.$executeRawUnsafe(sql);
}

async function createTenant(slug = unique('rls')): Promise<{ id: string }> {
  return db.tenant.create({
    data: {
      slug,
      name: slug,
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Etc/UTC',
      packKey: 'test',
      packVersion: '1',
    },
  });
}

describe('P0.7 RLS groundwork (ADR 050)', () => {
  it('enables RLS policies on high-risk tables and tenant context reads own rows', async () => {
    await ensureRlsMigration();

    const tenant = await createTenant();
    const account = await db.channelAccount.create({
      data: {
        tenantId: tenant.id,
        channelType: 'telegram',
        externalAccountId: unique('acct'),
        status: 'ACTIVE',
      },
    });
    const contact = await db.contact.create({
      data: {
        tenantId: tenant.id,
        channelAccountId: account.id,
        providerUserId: unique('user'),
        name: 'RLS Test',
      },
    });

    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
      return tx.contact.findMany({
        where: { id: contact.id },
        select: { id: true, tenantId: true },
      });
    });
    expect(rows).toEqual([{ id: contact.id, tenantId: tenant.id }]);

    const policies = await db.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename::text AS tablename
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('contacts','conversations','messages','leads','handovers','knowledge_chunks')
      GROUP BY tablename
      ORDER BY tablename`;
    expect(policies.map((p) => p.tablename)).toEqual([
      'contacts',
      'conversations',
      'handovers',
      'knowledge_chunks',
      'leads',
      'messages',
    ]);

    const rels = await db.$queryRaw<
      Array<{ relname: string; relrowsecurity: boolean }>
    >`
      SELECT c.relname::text AS relname, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('contacts','conversations','messages','leads','handovers','knowledge_chunks')
      ORDER BY c.relname`;
    expect(rels.every((r) => r.relrowsecurity)).toBe(true);
  });
});
