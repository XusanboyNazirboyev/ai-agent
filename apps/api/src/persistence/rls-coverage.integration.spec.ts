import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ownerClient } from './testing/test-clients.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('RLS coverage tests require agentcore_test');
const db = ownerClient();
afterAll(async () => {
  await db.$disconnect();
});

const POLICIES = [
  'tenant_isolation_delete',
  'tenant_isolation_insert',
  'tenant_isolation_select',
  'tenant_isolation_update',
];

describe('RLS coverage of tenant tables (plan S9)', () => {
  // RLS plan S9 put the four ADR 050 policies on every tenant table; a new
  // table with a tenant_id must arrive with them in its migration.
  it('every table with a tenant_id has RLS on and the four isolation policies', async () => {
    const rows = await db.$queryRaw<
      Array<{ table: string; rls: boolean; policies: string[] }>
    >`
      SELECT c.relname::text AS table,
             c.relrowsecurity AS rls,
             COALESCE(
               array_agg(p.policyname::text ORDER BY p.policyname)
                 FILTER (WHERE p.policyname IS NOT NULL),
               '{}'
             ) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
        AND NOT a.attisdropped
      LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = c.relname
      WHERE c.relkind = 'r'
      GROUP BY c.relname, c.relrowsecurity
      ORDER BY c.relname`;
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows
        .filter(
          (row) =>
            !row.rls ||
            POLICIES.some((policy) => !row.policies.includes(policy)),
        )
        .map((row) => row.table),
    ).toEqual([]);
  });
});
