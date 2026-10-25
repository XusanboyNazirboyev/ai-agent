import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import { hashPassword, verifyPassword } from '../webinbox/password.js';
import {
  ensureDemoConversations,
  ensureLocalSuperadmin,
  SUPERADMIN_EMAIL,
  SUPERADMIN_TENANT_SLUG,
} from './dev-superadmin.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('requires agentcore_test');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const FAST = { N: 1024, r: 8, p: 1 };
const hash = (password: string): Promise<string> =>
  hashPassword(password, FAST);
afterAll(async () => db.$disconnect());

describe('local superadmin bootstrap', () => {
  it('creates exactly one OWNER of one local tenant, idempotently', async () => {
    const first = await ensureLocalSuperadmin(db, { hash });
    const second = await ensureLocalSuperadmin(db, { hash });
    expect(second.status).toBe('unchanged');
    expect(second.password).toBeUndefined();
    expect(second.operatorId).toBe(first.operatorId);
    expect(['created', 'unchanged']).toContain(first.status);

    const tenant = await db.tenant.findUniqueOrThrow({
      where: { slug: SUPERADMIN_TENANT_SLUG },
    });
    expect(
      await db.operator.count({
        where: { tenantId: tenant.id, displayName: 'Local Superadmin' },
      }),
    ).toBe(1);
    const credential = await db.operatorCredential.findUniqueOrThrow({
      where: { email: SUPERADMIN_EMAIL },
    });
    const operator = await db.operator.findUniqueOrThrow({
      where: { id: credential.operatorId },
    });
    expect(operator).toMatchObject({
      tenantId: tenant.id,
      role: 'OWNER',
      isActive: true,
    });
    expect(credential.tenantId).toBe(tenant.id);
    // Only one account with this e-mail exists anywhere.
    expect(
      await db.operatorCredential.count({ where: { email: SUPERADMIN_EMAIL } }),
    ).toBe(1);
  });

  it('stores only a scrypt hash and rotates it on reset', async () => {
    const reset = await ensureLocalSuperadmin(db, {
      reset: true,
      password: 'first-test-password',
      hash,
    });
    expect(reset.password).toBe('first-test-password');
    const stored = await db.operatorCredential.findUniqueOrThrow({
      where: { email: SUPERADMIN_EMAIL },
    });
    expect(stored.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(stored.passwordHash).not.toContain('first-test-password');
    expect(
      await verifyPassword('first-test-password', stored.passwordHash),
    ).toBe(true);

    await ensureLocalSuperadmin(db, {
      reset: true,
      password: 'second-test-password',
      hash,
    });
    const rotated = await db.operatorCredential.findUniqueOrThrow({
      where: { email: SUPERADMIN_EMAIL },
    });
    expect(
      await verifyPassword('first-test-password', rotated.passwordHash),
    ).toBe(false);
    expect(
      await verifyPassword('second-test-password', rotated.passwordHash),
    ).toBe(true);
    expect(
      await db.operatorCredential.count({ where: { email: SUPERADMIN_EMAIL } }),
    ).toBe(1);
  });

  it('adds demo conversations only to its own tenant, once', async () => {
    const { tenantId } = await ensureLocalSuperadmin(db, { hash });
    const before = await db.conversation.count({ where: { tenantId } });
    const added = await ensureDemoConversations(db, tenantId);
    expect(added === 0 || added === 3).toBe(true);
    expect(await ensureDemoConversations(db, tenantId)).toBe(0);
    expect(await db.conversation.count({ where: { tenantId } })).toBe(
      before + added,
    );
  });
});
