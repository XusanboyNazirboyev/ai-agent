import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MfaService } from '../auth/mfa.service.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { hashPassword } from '../webinbox/password.js';
import { PlatformSessionService } from './platform-session.service.js';

/** ADR 048 §2/§5: without the keyring platform sign-in fails closed. */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('MFA tests require agentcore_test');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
afterAll(async () => {
  await db.$disconnect();
});

describe('platform sign-in without the keyring', () => {
  it('answers MFA_NOT_AVAILABLE after a correct password and creates no session', async () => {
    const email = `p-nokey-${randomUUID().slice(0, 8)}@example.test`;
    const admin = await db.platformAdmin.create({
      data: {
        email,
        displayName: 'nokey',
        role: 'PLATFORM_OWNER',
        passwordHash: await hashPassword('platform admin password', {
          N: 1024,
          r: 8,
          p: 1,
        }),
      },
    });
    const prisma = db as unknown as PrismaService;
    const sessions = new PlatformSessionService(
      prisma,
      undefined,
      new MfaService(prisma),
    );
    expect(await sessions.login(email, 'platform admin password')).toEqual({
      ok: false,
      code: 'MFA_NOT_AVAILABLE',
    });
    expect(
      await db.platformSession.count({ where: { adminId: admin.id } }),
    ).toBe(0);
  });
});
