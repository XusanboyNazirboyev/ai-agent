import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import { DOMAIN_PACKS } from '../packs/registry.js';
import { hashPassword, verifyPassword } from '../webinbox/password.js';
import { createTenantOwner, type TenantOwnerInput } from './tenant-owner.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('requires agentcore_test');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const FAST = { N: 1024, r: 8, p: 1 };
const hash = (password: string): Promise<string> =>
  hashPassword(password, FAST);
const PACK = [...DOMAIN_PACKS.keys()][0] as string;
afterAll(async () => db.$disconnect());

function input(suffix: string): Omit<TenantOwnerInput, 'passwordFile'> {
  return {
    slug: `ops-owner-${suffix}`,
    name: 'Ops owner test tenant',
    pack: PACK,
    defaultLocale: 'ru',
    timezone: 'Asia/Tashkent',
    email: `owner-${suffix}@example.test`,
    ownerName: 'Test Owner',
  };
}

describe('create tenant owner', () => {
  it('creates one tenant with one OWNER whose stored hash matches the password', async () => {
    const suffix = randomUUID().slice(0, 8);
    const result = await createTenantOwner(db, input(suffix), {
      password: 'given-password-for-test',
      hash,
    });
    expect(result.password).toBe('given-password-for-test');

    const tenant = await db.tenant.findUniqueOrThrow({
      where: { slug: `ops-owner-${suffix}` },
    });
    const pack = DOMAIN_PACKS.get(PACK);
    expect(tenant).toMatchObject({
      id: result.tenantId,
      defaultLocale: 'ru',
      timezone: 'Asia/Tashkent',
      packKey: pack?.key,
      packVersion: pack?.version,
    });
    expect(tenant.supportedLocales).toContain('ru');
    const operators = await db.operator.findMany({
      where: { tenantId: tenant.id },
    });
    expect(operators).toHaveLength(1);
    expect(operators[0]).toMatchObject({
      id: result.operatorId,
      role: 'OWNER',
    });
    const credential = await db.operatorCredential.findUniqueOrThrow({
      where: { email: `owner-${suffix}@example.test` },
    });
    expect(credential.tenantId).toBe(tenant.id);
    expect(credential.passwordHash).not.toContain('given-password-for-test');
    expect(
      await verifyPassword('given-password-for-test', credential.passwordHash),
    ).toBe(true);
  });

  it('refuses an existing slug or email and changes nothing', async () => {
    const suffix = randomUUID().slice(0, 8);
    const first = await createTenantOwner(db, input(suffix), { hash });
    const before = await db.operatorCredential.findUniqueOrThrow({
      where: { email: `owner-${suffix}@example.test` },
    });

    await expect(
      createTenantOwner(
        db,
        { ...input(suffix), email: `other-${suffix}@example.test` },
        { hash },
      ),
    ).rejects.toThrow(/already exists/);
    await expect(
      createTenantOwner(
        db,
        { ...input(suffix), slug: `ops-other-${suffix}` },
        { hash },
      ),
    ).rejects.toThrow(/already has a login/);

    expect(
      await db.tenant.count({ where: { slug: `ops-other-${suffix}` } }),
    ).toBe(0);
    expect(
      await db.operatorCredential.count({
        where: { email: `other-${suffix}@example.test` },
      }),
    ).toBe(0);
    const after = await db.operatorCredential.findUniqueOrThrow({
      where: { email: `owner-${suffix}@example.test` },
    });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.operatorId).toBe(first.operatorId);
  });
});
