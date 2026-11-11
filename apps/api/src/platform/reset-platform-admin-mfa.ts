import { MfaStore } from '../auth/mfa-store.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { PrismaService } from '../persistence/prisma.service.js';

/**
 * Server-side reset of a platform admin's second factor (ADR 048
 * "Consequences"): the way back in for the last PLATFORM_OWNER who lost the
 * authenticator and the recovery codes. Reuses the API's store operation.
 * Prints nothing secret; the admin enrols again at the next password sign-in.
 */
export const RESET_MFA_USAGE =
  'usage: ops:platform-admin-reset-mfa --email <email>';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function parseResetMfaArgs(argv: readonly string[]): {
  readonly email: string;
} {
  const problems: string[] = [];
  let email: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--email') {
      problems.push(`unknown argument ${flag ?? ''}`.trim());
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--'))
      problems.push('--email needs a value');
    else {
      email = value.trim().toLowerCase();
      index += 1;
    }
  }
  if (problems.length === 0 && !email) problems.push('--email is required');
  if (
    problems.length === 0 &&
    (!email || email.length > 254 || !EMAIL.test(email))
  )
    problems.push('--email: not an email address');
  if (problems.length > 0)
    throw new Error(`${problems.join('; ')}\n${RESET_MFA_USAGE}`);
  return { email: email ?? '' };
}

export async function resetPlatformAdminMfa(
  db: PrismaClient,
  email: string,
  now = new Date(),
): Promise<{ adminId: string }> {
  const admin = await db.platformAdmin.findUnique({
    where: { email },
    select: { id: true, isActive: true },
  });
  if (!admin) throw new Error('No platform admin with that email');
  if (!admin.isActive) throw new Error('That platform admin is inactive');
  const store = new MfaStore(db as unknown as PrismaService);
  await db.$transaction(async (tx) => {
    await store.clear(tx, { kind: 'PLATFORM', adminId: admin.id });
    await tx.mfaChallenge.deleteMany({
      where: { principalType: 'PLATFORM', principalId: admin.id },
    });
    await tx.platformSession.updateMany({
      where: { adminId: admin.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.platformAuditEvent.create({
      data: {
        actorAdminId: null,
        action: 'admin.mfa_reset',
        entityType: 'platform_admin',
        entityId: admin.id,
        safeSummary: { via: 'server_cli' },
      },
    });
  });
  return { adminId: admin.id };
}
