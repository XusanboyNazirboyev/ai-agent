import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import { resetPlatformAdminMfa } from './reset-platform-admin-mfa.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('MFA tests require agentcore_test');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
afterAll(async () => {
  await db.$disconnect();
});

async function enrolledAdmin(isActive = true): Promise<{
  id: string;
  email: string;
}> {
  const email = `p-reset-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await db.platformAdmin.create({
    data: {
      email,
      displayName: 'reset',
      role: 'PLATFORM_OWNER',
      isActive,
      totpKeyId: 'k1',
      totpNonce: new Uint8Array([1, 2, 3]),
      totpCiphertext: new Uint8Array([4, 5, 6]),
      totpEnabledAt: new Date(),
      totpLastStep: 42,
      mfaRecoveryHashes: ['a', 'b'],
    },
  });
  await db.platformSession.create({
    data: {
      adminId: admin.id,
      tokenHash: randomUUID().replace(/-/gu, '') + randomUUID().slice(0, 8),
      csrfHash: 'c',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  await db.mfaChallenge.create({
    data: {
      principalType: 'PLATFORM',
      principalId: admin.id,
      purpose: 'LOGIN',
      tokenHash: randomUUID().replace(/-/gu, '') + randomUUID().slice(0, 8),
      expiresAt: new Date(Date.now() + 300_000),
    },
  });
  return { id: admin.id, email };
}

describe('server CLI: reset platform admin MFA', () => {
  it('clears MFA, drops challenges, revokes sessions, audits; other admin untouched; rerun harmless', async () => {
    const target = await enrolledAdmin();
    const other = await enrolledAdmin();
    await resetPlatformAdminMfa(db, target.email);
    const row = await db.platformAdmin.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(row.totpEnabledAt).toBeNull();
    expect(row.totpCiphertext).toBeNull();
    expect(row.totpLastStep).toBeNull();
    expect(row.mfaRecoveryHashes).toEqual([]);
    expect(
      await db.platformSession.count({
        where: { adminId: target.id, revokedAt: null },
      }),
    ).toBe(0);
    expect(
      await db.mfaChallenge.count({ where: { principalId: target.id } }),
    ).toBe(0);
    const audit = await db.platformAuditEvent.findMany({
      where: { entityId: target.id, action: 'admin.mfa_reset' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorAdminId).toBeNull();
    expect(audit[0]?.safeSummary).toEqual({ via: 'server_cli' });

    await expect(
      resetPlatformAdminMfa(db, target.email),
    ).resolves.toBeDefined();
    const again = await db.platformAdmin.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(again.totpEnabledAt).toBeNull();

    const untouched = await db.platformAdmin.findUniqueOrThrow({
      where: { id: other.id },
    });
    expect(untouched.totpEnabledAt).not.toBeNull();
    expect(untouched.mfaRecoveryHashes).toEqual(['a', 'b']);
    expect(
      await db.platformSession.count({
        where: { adminId: other.id, revokedAt: null },
      }),
    ).toBe(1);
    expect(
      await db.mfaChallenge.count({ where: { principalId: other.id } }),
    ).toBe(1);
  });

  it('refuses an unknown e-mail and an inactive admin', async () => {
    await expect(
      resetPlatformAdminMfa(db, `nobody-${randomUUID()}@example.test`),
    ).rejects.toThrow(/No platform admin/u);
    const inactive = await enrolledAdmin(false);
    await expect(resetPlatformAdminMfa(db, inactive.email)).rejects.toThrow(
      /inactive/u,
    );
    const row = await db.platformAdmin.findUniqueOrThrow({
      where: { id: inactive.id },
    });
    expect(row.totpEnabledAt).not.toBeNull();
  });
});
