/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from './postgres-adapter.js';
import { TenantContextAdapterFactory } from './tenant-adapter.js';
import { ensureRlsAppRole } from './testing/rls-app-role.js';
import {
  runWithTenant,
  runWithTenantSlot,
  setTenant,
  TenantContextError,
} from './tenant-context.js';

// RLS enforcement plan S2: the tenant context reaches PostgreSQL through the
// adapter wrapper. The test database user may not create roles, so the proof
// uses a probe table in its own schema with FORCE ROW LEVEL SECURITY (the
// owner is then bound by the policy too); shared tables are not touched.
// The app-level acceptance specs run as a NOBYPASSRLS role in CI
// (`pnpm test:rls:strict`, plan S8).

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Tenant adapter tests require agentcore_test');

const owner = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const missed: string[] = [];
let roleEnv: Record<string, unknown> = process.env;
const client = (mode: 'warn' | 'strict') =>
  new PrismaClient({
    adapter: new TenantContextAdapterFactory(
      createPostgresAdapter(roleEnv, 'TEST_'),
      mode,
      (sql) => missed.push(sql),
    ),
  });
let strict: PrismaClient;
let warn: PrismaClient;
const POLICY =
  "tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid";

beforeAll(async () => {
  // A superuser (the CI database user) bypasses RLS even with FORCE: there the
  // test connects as a NOBYPASSRLS login role instead. Locally the test user
  // is the table owner without CREATEROLE, and FORCE binds the owner.
  await owner.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS rls_probe');
  await owner.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS rls_probe.rows (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)',
  );
  await owner.$executeRawUnsafe(
    'ALTER TABLE rls_probe.rows ENABLE ROW LEVEL SECURITY',
  );
  await owner.$executeRawUnsafe(
    'ALTER TABLE rls_probe.rows FORCE ROW LEVEL SECURITY',
  );
  await owner.$executeRawUnsafe(
    'DROP POLICY IF EXISTS tenant_isolation ON rls_probe.rows',
  );
  await owner.$executeRawUnsafe(
    `CREATE POLICY tenant_isolation ON rls_probe.rows USING (${POLICY}) WITH CHECK (${POLICY})`,
  );
  // A login role that cannot bypass RLS; only created where we may (CI).
  const role = await ensureRlsAppRole(owner, ['public', 'rls_probe']);
  if (role)
    roleEnv = {
      ...process.env,
      TEST_POSTGRES_USER: role.user,
      TEST_POSTGRES_PASSWORD: role.password,
    };
  strict = client('strict');
  warn = client('warn');
});

afterAll(async () => {
  await Promise.all([strict.$disconnect(), warn.$disconnect()]);
  await owner.$disconnect();
});

/** Inserts a probe row as its tenant (the policy checks inserts too). */
async function probeRow(tenantId: string): Promise<string> {
  const id = randomUUID();
  await runWithTenant(
    tenantId,
    () =>
      strict.$executeRaw`INSERT INTO rls_probe.rows (id, tenant_id) VALUES (${id}::uuid, ${tenantId}::uuid)`,
  );
  return id;
}

const visible = (ids: string[]) =>
  strict.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM rls_probe.rows WHERE id = ANY(${ids}::uuid[])`;

async function tenantWithContact() {
  const id = randomUUID();
  const tenant = await owner.tenant.create({
    data: {
      slug: `rls-app-${id}`,
      name: 'T',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await owner.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `a-${id}`,
      status: 'ACTIVE',
    },
  });
  const contact = await owner.contact.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: `u-${id}`,
      name: `C-${id}`,
    },
  });
  return { tenantId: tenant.id, accountId: account.id, contactId: contact.id };
}

describe('tenant context through the adapter (RLS plan S2)', () => {
  it('scopes single statements and interactive transactions to the tenant', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const rowA = await probeRow(a);
    const rowB = await probeRow(b);
    const ids = [rowA, rowB];

    expect(
      (await runWithTenant(a, () => visible(ids))).map((r) => r.id),
    ).toEqual([rowA]);
    const inTx = await runWithTenant(b, () =>
      strict.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM rls_probe.rows WHERE id = ANY(${ids}::uuid[])`;
        const [setting] = await tx.$queryRaw<{ tenant: string }[]>`
          SELECT current_setting('app.tenant_id', true) AS tenant`;
        return { rows, tenant: setting?.tenant };
      }),
    );
    expect(inTx.rows.map((r) => r.id)).toEqual([rowB]);
    expect(inTx.tenant).toBe(b);

    // The HTTP shape: an empty slot, filled after the session check.
    const viaSlot = await runWithTenantSlot(async () => {
      setTenant(a);
      return visible(ids);
    });
    expect(viaSlot.map((r) => r.id)).toEqual([rowA]);

    // Another tenant's row can be neither changed nor written.
    const changed = await runWithTenant(
      a,
      () =>
        strict.$executeRaw`UPDATE rls_probe.rows SET tenant_id = tenant_id WHERE id = ${rowB}::uuid`,
    );
    expect(changed).toBe(0);
    await expect(
      runWithTenant(
        a,
        () =>
          strict.$executeRaw`INSERT INTO rls_probe.rows (id, tenant_id) VALUES (${randomUUID()}::uuid, ${b}::uuid)`,
      ),
    ).rejects.toThrow();
  });

  it('gives ORM queries the tenant: inside a transaction and on their own', async () => {
    const t = await tenantWithContact();
    const found = await runWithTenant(t.tenantId, () =>
      strict.contact.findMany({
        where: { id: t.contactId },
        select: { id: true },
      }),
    );
    expect(found).toHaveLength(1);
    const nested = await runWithTenant(t.tenantId, () =>
      strict.$transaction(async (tx) => {
        await tx.contact.update({
          where: { id: t.contactId },
          data: { name: 'renamed' },
        });
        const [setting] = await tx.$queryRaw<{ tenant: string }[]>`
          SELECT current_setting('app.tenant_id', true) AS tenant`;
        return setting?.tenant;
      }),
    );
    expect(nested).toBe(t.tenantId);
    // A nested write (Prisma opens its own transaction) also carries it.
    const created = await runWithTenant(t.tenantId, () =>
      strict.conversation.create({
        data: {
          tenantId: t.tenantId,
          channelAccountId: t.accountId,
          contactId: t.contactId,
          providerChatId: `c-${randomUUID()}`,
        },
        select: { id: true },
      }),
    );
    expect(created.id).toBeTruthy();
  });

  it('keeps concurrent work of two tenants apart', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const ids = [await probeRow(a), await probeRow(b)];
    const seen = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const [tenant, own] = i % 2 ? [a, ids[0]] : [b, ids[1]];
        return runWithTenant(tenant, async () => {
          const rows = await visible(ids);
          return rows.length === 1 && rows[0]?.id === own;
        });
      }),
    );
    expect(seen.every(Boolean)).toBe(true);
  });

  it('strict refuses a statement without a tenant; warn reports it', async () => {
    const t = await tenantWithContact();
    await expect(
      strict.contact.findMany({ where: { id: t.contactId } }),
    ).rejects.toThrow(/without a tenant context/u);
    await expect(strict.$transaction(async () => 1)).rejects.toThrow(
      /without a tenant context/u,
    );
    expect(() =>
      runWithTenant(t.tenantId, () => setTenant(randomUUID())),
    ).toThrow(TenantContextError);
    missed.length = 0;
    const rows = await warn.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM rls_probe.rows`;
    expect(rows[0]?.n).toBe(0);
    expect(missed.length).toBeGreaterThan(0);
  });
});
