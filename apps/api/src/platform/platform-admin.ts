import type { PrismaClient } from '../generated/prisma/client.js';
import { hashPassword } from '../webinbox/password.js';

/**
 * Bootstrap of the platform console (ADR 047 §1): creates a platform admin
 * (by default PLATFORM_OWNER) like `create-tenant-owner` creates a tenant
 * OWNER. The password is random, stored hashed and written only to a 0600
 * file; it is never printed or logged. Refuses an email that exists.
 */
export interface PlatformAdminInput {
  readonly email: string;
  readonly name: string;
  readonly role: 'PLATFORM_OWNER' | 'PLATFORM_SUPPORT';
  readonly passwordFile: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const FLAGS = {
  '--email': 'email',
  '--name': 'name',
  '--role': 'role',
  '--password-file': 'passwordFile',
} as const satisfies Record<string, keyof PlatformAdminInput>;

export const PLATFORM_ADMIN_USAGE =
  'usage: ops:platform-admin --email <email> --name <display name> ' +
  '--password-file <path> [--role PLATFORM_OWNER|PLATFORM_SUPPORT]';

export function parsePlatformAdminArgs(
  argv: readonly string[],
): PlatformAdminInput {
  const values: Partial<Record<keyof PlatformAdminInput, string>> = {};
  const problems: string[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !(flag in FLAGS)) {
      problems.push(`unknown argument ${flag ?? ''}`.trim());
      continue;
    }
    if (value === undefined || value.startsWith('--')) {
      problems.push(`${flag} needs a value`);
      index -= 1;
      continue;
    }
    values[FLAGS[flag as keyof typeof FLAGS]] = value.trim();
  }
  for (const flag of ['--email', '--name', '--password-file'] as const)
    if (!values[FLAGS[flag]]) problems.push(`${flag} is required`);
  if (problems.length > 0)
    throw new Error(`${problems.join('; ')}\n${PLATFORM_ADMIN_USAGE}`);
  const email = (values.email ?? '').toLowerCase();
  if (email.length > 254 || !EMAIL.test(email))
    problems.push('--email: not an email address');
  const name = values.name ?? '';
  if (name.length > 160) problems.push('--name: at most 160 characters');
  const role = values.role ?? 'PLATFORM_OWNER';
  if (role !== 'PLATFORM_OWNER' && role !== 'PLATFORM_SUPPORT')
    problems.push('--role: PLATFORM_OWNER or PLATFORM_SUPPORT');
  if (problems.length > 0) throw new Error(problems.join('; '));
  return {
    email,
    name,
    role: role as PlatformAdminInput['role'],
    passwordFile: values.passwordFile ?? '',
  };
}

export async function createPlatformAdmin(
  db: PrismaClient,
  input: Omit<PlatformAdminInput, 'passwordFile'>,
  options: {
    readonly password: string;
    readonly hash?: (password: string) => Promise<string>;
  },
): Promise<{ adminId: string }> {
  if (await db.platformAdmin.findUnique({ where: { email: input.email } }))
    throw new Error('A platform admin with that email already exists');
  const passwordHash = await (options.hash ?? hashPassword)(options.password);
  return db.$transaction(async (tx) => {
    const admin = await tx.platformAdmin.create({
      data: {
        email: input.email,
        displayName: input.name,
        role: input.role,
        passwordHash,
      },
    });
    await tx.platformAuditEvent.create({
      data: {
        action: 'admin.created_by_cli',
        entityType: 'platform_admin',
        entityId: admin.id,
        safeSummary: { role: admin.role },
      },
    });
    return { adminId: admin.id };
  });
}
