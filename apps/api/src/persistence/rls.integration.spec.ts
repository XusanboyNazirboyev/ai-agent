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

async function ensurePersonRlsMigration(): Promise<void> {
  const sql = readFileSync(
    resolve(
      process.cwd(),
      'prisma/migrations/20261118090000_person_identity/migration.sql',
    ),
    'utf8',
  );
  // Only the RLS part is re-applied (idempotent: DROP POLICY IF EXISTS).
  await db.$executeRawUnsafe(
    sql.slice(sql.indexOf('ALTER TABLE "persons" ENABLE ROW LEVEL SECURITY')),
  );
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

  it('isolates persons (ADR 052) per tenant under RLS', async () => {
    await ensurePersonRlsMigration();
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const person = await db.person.create({
      data: { tenantId: tenantA.id, displayName: 'RLS Person' },
    });

    const policies = await db.$queryRaw<Array<{ cmd: string }>>`
      SELECT cmd::text AS cmd FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'persons'
      ORDER BY cmd`;
    expect(policies.map((p) => p.cmd)).toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
    const [rel] = await db.$queryRaw<Array<{ relrowsecurity: boolean }>>`
      SELECT relrowsecurity FROM pg_class
      WHERE oid = 'public.persons'::regclass`;
    expect(rel?.relrowsecurity).toBe(true);

    const own = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA.id}, true)`;
      return tx.person.findMany({ where: { id: person.id } });
    });
    expect(own).toHaveLength(1);

    // The table owner bypasses RLS unless FORCE is set (ADR 050), and a
    // superuser (the CI database role) bypasses even FORCE. So the foreign-
    // tenant read runs inside a transaction that is always rolled back (DDL
    // and SET LOCAL are transactional): as a non-superuser owner with FORCE,
    // or, for a superuser, as a throwaway non-owner role that RLS applies to.
    const rolledBack = new Error('rollback');
    let foreign: number | null = null;
    let own2: number | null = null;
    await db
      .$transaction(async (tx) => {
        const [role] = await tx.$queryRaw<Array<{ rolsuper: boolean }>>`
          SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
        if (role?.rolsuper) {
          const probe = `rls_probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
          await tx.$executeRawUnsafe(`CREATE ROLE ${probe} NOLOGIN`);
          await tx.$executeRawUnsafe(`GRANT SELECT ON "persons" TO ${probe}`);
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${probe}`);
        } else {
          await tx.$executeRawUnsafe(
            'ALTER TABLE "persons" FORCE ROW LEVEL SECURITY',
          );
        }
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantB.id}, true)`;
        foreign = (await tx.person.findMany({ where: { id: person.id } }))
          .length;
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA.id}, true)`;
        own2 = (await tx.person.findMany({ where: { id: person.id } })).length;
        throw rolledBack;
      })
      .catch((error: unknown) => {
        if (error !== rolledBack) throw error;
      });
    expect(foreign).toBe(0);
    expect(own2).toBe(1);
  });
});
