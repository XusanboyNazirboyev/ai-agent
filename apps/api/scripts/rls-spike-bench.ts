/**
 * ADR 054 S0 spike benchmark (not run in CI). Measures the latency the RLS
 * Prisma extension adds, against the agentcore_test database only.
 *
 * Run from apps/api, with the repo `.env` present and no dev API running:
 *   pnpm exec tsx scripts/rls-spike-bench.ts
 * It seeds two tenants (2000 contacts/conversations/messages each) and two
 * throwaway NOSUPERUSER NOBYPASSRLS roles, runs 20 warm-ups plus 200 measured
 * iterations per case and variant, prints a table (p50/p95 in ms), then removes
 * everything it created. Role DDL uses the local superuser connection when the
 * test owner cannot create roles (see rls-spike-support.ts).
 *
 * Variants:
 *   owner-plain : owner role, no extension (the owner bypasses RLS: today's cost)
 *   app-ext     : non-superuser role + RLS extension (strict) with tenant context
 *   app-plain   : non-superuser role, no extension; the role carries
 *                 `ALTER ROLE ... SET app.tenant_id = '<tenant>'` so every new
 *                 session already has the setting. RLS policies are evaluated but
 *                 no BEGIN/set_config/COMMIT is added: isolates policy cost.
 */
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  parsePostgresEnvironment,
  postgresPoolOptions,
} from '../src/config/postgres-config.js';
import { withRlsExtension } from '../src/persistence/rls-extension.js';
import {
  createThrowawayRole,
  dropThrowawayRole,
  newClient,
  removeTenant,
  runRoleDdl,
  seedTenant,
  testSource,
  type SeededTenant,
  type ThrowawayRole,
} from '../src/persistence/rls-spike-support.js';
import { runWithTenant } from '../src/persistence/tenant-context.js';

loadEnv({ path: resolve(process.cwd(), '../../.env') });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('The RLS spike benchmark only runs against agentcore_test');

const WARMUP = 20;
const ITERATIONS = 200;
const ROWS = 2000;

interface Variant {
  readonly name: string;
  readonly client: PrismaClient;
  readonly wrap: <T>(tenantId: string, fn: () => Promise<T>) => Promise<T>;
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)] as number;
}

async function measure(fn: () => Promise<unknown>): Promise<number[]> {
  for (let i = 0; i < WARMUP; i++) await fn();
  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  return times.sort((x, y) => x - y);
}

async function main(): Promise<void> {
  const owner = newClient(process.env);
  const roles: ThrowawayRole[] = [];
  const tenants: SeededTenant[] = [];
  const clients: PrismaClient[] = [];
  let sequence = 1000;
  try {
    const [version] = await owner.$queryRaw<Array<{ v: string }>>`
      SELECT version() AS v`;
    const tenantA = await seedTenant(owner, ROWS);
    tenants.push(tenantA);
    tenants.push(await seedTenant(owner, ROWS));
    const extRole = await createThrowawayRole(process.env, owner);
    roles.push(extRole);
    const plainRole = await createThrowawayRole(process.env, owner);
    roles.push(plainRole);
    await runRoleDdl(process.env, owner, [
      `ALTER ROLE ${plainRole.name} SET app.tenant_id = '${tenantA.tenantId}'`,
    ]);
    const extBase = newClient(process.env, extRole);
    const plainBase = newClient(process.env, plainRole);
    clients.push(extBase, plainBase);
    const ext = withRlsExtension(extBase, { mode: 'strict' });
    const passthrough = <T>(_t: string, fn: () => Promise<T>): Promise<T> =>
      fn();
    const variants: Variant[] = [
      { name: 'owner-plain', client: owner, wrap: passthrough },
      {
        name: 'app-ext',
        client: ext,
        wrap: (tenantId, fn) => runWithTenant(tenantId, fn),
      },
      { name: 'app-plain', client: plainBase, wrap: passthrough },
    ];

    const tenantId = tenantA.tenantId;
    const results: Array<{
      op: string;
      variant: string;
      p50: number;
      p95: number;
    }> = [];
    for (const v of variants) {
      const c = v.client;
      const cases: Array<[string, () => Promise<unknown>]> = [
        [
          'inbox list (take 51, include contact+lead+handover)',
          (): Promise<unknown> =>
            v.wrap(tenantId, () =>
              c.conversation.findMany({
                where: { tenantId },
                orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
                take: 51,
                include: {
                  contact: { select: { name: true } },
                  leads: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    select: {
                      score: true,
                      status: true,
                      scoreSetByOperator: true,
                    },
                  },
                  handovers: {
                    where: { status: { in: ['OPEN', 'TAKEN'] } },
                    orderBy: { openedAt: 'asc' },
                    take: 1,
                    select: { openedAt: true, slaDueAt: true },
                  },
                },
              }),
            ),
        ],
        [
          'single message insert',
          (): Promise<unknown> =>
            v.wrap(tenantId, () =>
              c.message.create({
                data: {
                  tenantId,
                  conversationId: tenantA.conversationIds[0] as string,
                  channelAccountId: tenantA.channelAccountId,
                  authorType: 'BOT',
                  direction: 'OUTBOUND',
                  text: 'bench',
                  sequence: ++sequence,
                  providerChatId: 'chat-0',
                },
              }),
            ),
        ],
        [
          'interactive tx, 5 model calls',
          (): Promise<unknown> =>
            v.wrap(tenantId, () =>
              c.$transaction(async (tx) => {
                const conversationId = tenantA.conversationIds[1] as string;
                await tx.conversation.findFirst({
                  where: { tenantId, id: conversationId },
                });
                await tx.contact.findFirst({
                  where: { tenantId, id: tenantA.contactIds[1] as string },
                });
                await tx.message.findMany({
                  where: { tenantId, conversationId },
                  take: 20,
                });
                await tx.message.create({
                  data: {
                    tenantId,
                    conversationId,
                    channelAccountId: tenantA.channelAccountId,
                    authorType: 'BOT',
                    direction: 'OUTBOUND',
                    text: 'bench tx',
                    sequence: ++sequence,
                    providerChatId: 'chat-1',
                  },
                });
                await tx.conversation.update({
                  where: { id: conversationId },
                  data: { language: 'en' },
                });
              }),
            ),
        ],
      ];
      for (const [op, fn] of cases) {
        const times = await measure(fn);
        results.push({
          op,
          variant: v.name,
          p50: percentile(times, 50),
          p95: percentile(times, 95),
        });
      }
    }
    const pool = postgresPoolOptions(
      parsePostgresEnvironment(testSource(process.env)),
    );
    console.log(`Postgres: ${version?.v.split(' on ')[0] ?? '?'}`);
    console.log(
      `pool max: ${String(pool.max)}; rows per tenant: ${ROWS} contacts/conversations/messages; ${WARMUP} warm-up + ${ITERATIONS} iterations`,
    );
    console.log('op | variant | p50 ms | p95 ms');
    for (const r of results)
      console.log(
        `${r.op} | ${r.variant} | ${r.p50.toFixed(2)} | ${r.p95.toFixed(2)}`,
      );
  } finally {
    for (const c of clients) await c.$disconnect();
    for (const t of tenants) await removeTenant(owner, t.tenantId);
    for (const r of roles) await dropThrowawayRole(process.env, owner, r);
    await owner.$disconnect();
  }
}

await main();
