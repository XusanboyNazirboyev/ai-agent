import { randomBytes, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import pg from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from './postgres-adapter.js';

/**
 * ADR 054 S0 spike helpers shared by the integration spec and the benchmark.
 * Test database only: callers must have checked TEST_POSTGRES_DATABASE.
 */

export const RLS_TABLES = [
  'contacts',
  'conversations',
  'messages',
  'leads',
  'handovers',
  'knowledge_chunks',
  'persons',
  'person_merges',
] as const;

export interface ThrowawayRole {
  readonly name: string;
  readonly password: string;
}

type Env = Record<string, string | undefined>;

export function testSource(
  env: Env,
  override: Partial<Record<'user' | 'password', string>> = {},
): Record<string, unknown> {
  return {
    POSTGRES_HOST: env.TEST_POSTGRES_HOST,
    POSTGRES_PORT: env.TEST_POSTGRES_PORT,
    POSTGRES_DATABASE: env.TEST_POSTGRES_DATABASE,
    POSTGRES_USER: override.user ?? env.TEST_POSTGRES_USER,
    POSTGRES_PASSWORD: override.password ?? env.TEST_POSTGRES_PASSWORD,
    POSTGRES_SSL_MODE: env.TEST_POSTGRES_SSL_MODE,
  };
}

export function newClient(
  env: Env,
  role?: ThrowawayRole,
  logQueries?: (sql: string) => void,
): PrismaClient {
  const adapter = createPostgresAdapter(
    testSource(env, role ? { user: role.name, password: role.password } : {}),
  );
  if (!logQueries) return new PrismaClient({ adapter });
  const client = new PrismaClient({
    adapter,
    log: [{ emit: 'event', level: 'query' }],
  });
  (
    client as unknown as {
      $on: (e: 'query', cb: (q: { query: string }) => void) => void;
    }
  ).$on('query', (q) => logQueries(q.query));
  return client;
}

/**
 * Runs role DDL. CI's database user is a superuser and can create roles itself;
 * on a dev machine the owner role (`agentcore`) has no CREATEROLE, so a local
 * superuser connection is used instead (RLS_SPIKE_ADMIN_USER, default the OS
 * user; Postgres.app trusts local connections, no password is read or stored).
 */
export async function runRoleDdl(
  env: Env,
  owner: PrismaClient,
  statements: string[],
): Promise<void> {
  const [who] = await owner.$queryRaw<
    Array<{ super: boolean; createrole: boolean }>
  >`SELECT rolsuper AS super, rolcreaterole AS createrole FROM pg_roles WHERE rolname = current_user`;
  if (who?.super || who?.createrole) {
    for (const sql of statements) await owner.$executeRawUnsafe(sql);
    return;
  }
  const pool = new pg.Pool({
    host: env.TEST_POSTGRES_HOST,
    port: Number(env.TEST_POSTGRES_PORT),
    database: env.TEST_POSTGRES_DATABASE,
    user: env.RLS_SPIKE_ADMIN_USER ?? userInfo().username,
    ssl: false,
    max: 1,
  });
  try {
    for (const sql of statements) await pool.query(sql);
  } finally {
    await pool.end();
  }
}

/** NOSUPERUSER NOBYPASSRLS login role with DML on the RLS tables only. */
export async function createThrowawayRole(
  env: Env,
  owner: PrismaClient,
): Promise<ThrowawayRole> {
  const name = `rls_spike_${randomBytes(6).toString('hex')}`;
  const password = randomBytes(18).toString('hex');
  await runRoleDdl(env, owner, [
    `CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`,
    `GRANT USAGE ON SCHEMA public TO ${name}`,
    ...RLS_TABLES.map(
      (t) => `GRANT SELECT, INSERT, UPDATE, DELETE ON "${t}" TO ${name}`,
    ),
  ]);
  return { name, password };
}

export async function dropThrowawayRole(
  env: Env,
  owner: PrismaClient,
  role: ThrowawayRole,
): Promise<void> {
  await runRoleDdl(env, owner, [
    `DROP OWNED BY ${role.name}`,
    `DROP ROLE IF EXISTS ${role.name}`,
  ]);
}

export interface SeededTenant {
  readonly tenantId: string;
  readonly channelAccountId: string;
  readonly contactIds: string[];
  readonly conversationIds: string[];
}

/** Seeds one tenant with `count` contacts, conversations and one message each (as owner). */
export async function seedTenant(
  owner: PrismaClient,
  count: number,
): Promise<SeededTenant> {
  const slug = `rlsspike-${randomUUID()}`;
  const tenant = await owner.tenant.create({
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
  const account = await owner.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `acct-${randomUUID()}`,
      status: 'ACTIVE',
    },
  });
  const contactIds = Array.from({ length: count }, () => randomUUID());
  const conversationIds = Array.from({ length: count }, () => randomUUID());
  const base = Date.now() - count * 1000;
  await owner.contact.createMany({
    data: contactIds.map((id, i) => ({
      id,
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: `u-${i}-${randomUUID()}`,
      name: `Contact ${i}`,
    })),
  });
  await owner.conversation.createMany({
    data: conversationIds.map((id, i) => ({
      id,
      tenantId: tenant.id,
      channelAccountId: account.id,
      contactId: contactIds[i] as string,
      providerChatId: `chat-${i}`,
      updatedAt: new Date(base + i * 1000),
    })),
  });
  await owner.message.createMany({
    data: conversationIds.map((conversationId, i) => ({
      tenantId: tenant.id,
      conversationId,
      channelAccountId: account.id,
      authorType: 'CUSTOMER' as const,
      direction: 'INBOUND' as const,
      text: `seed message ${i}`,
      sequence: 1,
      providerChatId: `chat-${i}`,
    })),
  });
  return {
    tenantId: tenant.id,
    channelAccountId: account.id,
    contactIds,
    conversationIds,
  };
}

/** Deletes a seeded tenant; messages, conversations and contacts cascade from tenant. */
export async function removeTenant(
  owner: PrismaClient,
  tenantId: string,
): Promise<void> {
  await owner.message.deleteMany({ where: { tenantId } });
  await owner.conversation.deleteMany({ where: { tenantId } });
  await owner.contact.deleteMany({ where: { tenantId } });
  await owner.channelAccount.deleteMany({ where: { tenantId } });
  await owner.tenant.delete({ where: { id: tenantId } });
}

/**
 * Records every statement sent over any `pg` client while `fn` runs (the Prisma
 * query log omits BEGIN). Prototype instrumentation for the spike only.
 */
export async function recordStatements(
  fn: () => Promise<unknown>,
): Promise<string[]> {
  const proto = pg.Client.prototype as unknown as {
    query: (...args: unknown[]) => unknown;
  };
  const original = proto.query;
  const seen: string[] = [];
  proto.query = function (this: unknown, ...args: unknown[]): unknown {
    const first = args[0];
    const text =
      typeof first === 'string'
        ? first
        : ((first as { text?: string } | undefined)?.text ?? '?');
    seen.push(text);
    return original.apply(this, args);
  };
  try {
    await fn();
  } finally {
    proto.query = original;
  }
  return seen;
}
