import { randomBytes } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import type { PrismaClient } from '../generated/prisma/client.js';
import { INITIAL_LOCALE_PACKS } from '../locales/locale-packs.js';
import { DOMAIN_PACKS } from '../packs/registry.js';
import { hashPassword } from '../webinbox/password.js';

/**
 * Creates a tenant and its first OWNER web login on a server (ADR 035): the
 * production counterpart of the local superadmin (ADR 025). One-time by
 * design: it refuses a slug or an email that already exists and changes
 * nothing then. The password is random, stored hashed and written only to a
 * file (mode 0600); it is never printed or logged.
 */
export interface TenantOwnerInput {
  readonly slug: string;
  readonly name: string;
  /** Domain Pack as `key@version`, e.g. one of the registered packs. */
  readonly pack: string;
  readonly defaultLocale: string;
  readonly timezone: string;
  readonly email: string;
  readonly ownerName: string;
  /** Where the generated password is written (mode 0600). */
  readonly passwordFile: string;
}

export interface TenantOwnerResult {
  readonly tenantId: string;
  readonly operatorId: string;
  readonly password: string;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FLAGS = {
  '--slug': 'slug',
  '--name': 'name',
  '--pack': 'pack',
  '--locale': 'defaultLocale',
  '--timezone': 'timezone',
  '--email': 'email',
  '--owner-name': 'ownerName',
  '--password-file': 'passwordFile',
} as const satisfies Record<string, keyof TenantOwnerInput>;

export const TENANT_OWNER_USAGE =
  'usage: create-tenant-owner --slug <slug> --name <name> --pack <key@version> ' +
  '--locale <locale> --timezone <IANA zone> --email <email> ' +
  '--owner-name <name> --password-file <path>';

/** Parses and validates the command line; throws with every problem found. */
export function parseTenantOwnerArgs(
  argv: readonly string[],
): TenantOwnerInput {
  const values: Partial<Record<keyof TenantOwnerInput, string>> = {};
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
  for (const [flag, key] of Object.entries(FLAGS))
    if (!values[key]) problems.push(`${flag} is required`);
  if (problems.length > 0)
    throw new Error(`${problems.join('; ')}\n${TENANT_OWNER_USAGE}`);

  const input = values as Record<keyof TenantOwnerInput, string>;
  if (!SLUG.test(input.slug))
    problems.push('--slug: lowercase letters, digits and hyphens, at most 80');
  if (input.name.length > 200) problems.push('--name: at most 200 characters');
  if (!DOMAIN_PACKS.has(input.pack))
    problems.push(`--pack: one of ${[...DOMAIN_PACKS.keys()].join(', ')}`);
  const locales = INITIAL_LOCALE_PACKS.map((locale) => locale.id as string);
  if (!locales.includes(input.defaultLocale))
    problems.push(`--locale: one of ${locales.join(', ')}`);
  if (!isTimeZone(input.timezone))
    problems.push('--timezone: an IANA time zone such as Asia/Tashkent');
  const email = input.email.toLowerCase();
  if (email.length > 254 || !EMAIL.test(email))
    problems.push('--email: not an email address');
  if (input.ownerName.length > 200)
    problems.push('--owner-name: at most 200 characters');
  if (problems.length > 0) throw new Error(problems.join('; '));
  return { ...input, email };
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export async function createTenantOwner(
  db: PrismaClient,
  input: Omit<TenantOwnerInput, 'passwordFile'>,
  options: {
    password?: string;
    hash?: (password: string) => Promise<string>;
  } = {},
): Promise<TenantOwnerResult> {
  if (await db.tenant.findUnique({ where: { slug: input.slug } }))
    throw new Error(`A tenant with slug "${input.slug}" already exists`);
  if (await db.operatorCredential.findUnique({ where: { email: input.email } }))
    throw new Error('That email already has a login');

  const pack = DOMAIN_PACKS.get(input.pack);
  if (!pack) throw new Error(`Unknown pack ${input.pack}`);
  const password = options.password ?? generateOwnerPassword();
  const passwordHash = await (options.hash ?? hashPassword)(password);
  return db.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        slug: input.slug,
        name: input.name,
        defaultLocale: input.defaultLocale,
        supportedLocales: INITIAL_LOCALE_PACKS.map((locale) => locale.id),
        timezone: input.timezone,
        packKey: pack.key,
        packVersion: pack.version,
      },
    });
    const operator = await tx.operator.create({
      data: {
        tenantId: tenant.id,
        displayName: input.ownerName,
        role: 'OWNER',
      },
    });
    await tx.operatorCredential.create({
      data: {
        tenantId: tenant.id,
        operatorId: operator.id,
        email: input.email,
        passwordHash,
      },
    });
    return { tenantId: tenant.id, operatorId: operator.id, password };
  });
}

export function generateOwnerPassword(): string {
  return randomBytes(18).toString('base64url');
}

/** Writes the password for the operator to read once; never overwrites. */
export async function writePasswordFile(
  file: string,
  password: string,
): Promise<void> {
  await writeFile(file, `${password}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(file, 0o600);
}
