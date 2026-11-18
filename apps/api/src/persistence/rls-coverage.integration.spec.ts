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

/**
 * RLS plan S9: tables with a `tenant_id` column that have no tenant isolation
 * policy yet. Each domain slice adds its policies in a migration and removes
 * its tables from this list; a new tenant table must arrive with policies.
 */
const PENDING = new Set([
  // Identity: looked up across tenants on the privileged handle.
  'mfa_challenges',
  'operator_api_tokens',
  'operator_credentials',
  'operator_invites',
  'operator_password_resets',
  'operator_sessions',
  'operators',
  // Leads, audit, billing and the platform.
  'audit_events',
  'lead_stages',
  'platform_audit_events',
  'subscription_payments',
  'tenant_subscriptions',
]);

const POLICIES = [
  'tenant_isolation_delete',
  'tenant_isolation_insert',
  'tenant_isolation_select',
  'tenant_isolation_update',
];

describe('RLS coverage of tenant tables (plan S9)', () => {
  it('every table with a tenant_id has the four isolation policies, or is pending', async () => {
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
    const covered = rows.filter((row) => !PENDING.has(row.table));
    expect(
      covered
        .filter(
          (row) =>
            !row.rls ||
            POLICIES.some((policy) => !row.policies.includes(policy)),
        )
        .map((row) => row.table),
    ).toEqual([]);
    // A pending table that already has policies leaves the list.
    expect(
      rows
        .filter((row) => PENDING.has(row.table) && row.policies.length > 0)
        .map((row) => row.table),
    ).toEqual([]);
    const tables = new Set(rows.map((row) => row.table));
    expect([...PENDING].filter((table) => !tables.has(table))).toEqual([]);
  });
});
