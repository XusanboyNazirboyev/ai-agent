import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { PrismaClient } from '../generated/prisma/client.js';
import { hashPassword } from '../webinbox/password.js';

/**
 * Local development "superadmin" (see ADR 025). There is no platform-level
 * role in the data model: every operator belongs to exactly one tenant. This
 * is therefore an OWNER of a dedicated local tenant, nothing more: it cannot
 * read or change any other tenant, and no request path treats it specially.
 */
export const SUPERADMIN_EMAIL = 'superadmin@agentcore.local';
export const SUPERADMIN_TENANT_SLUG = 'dev-local-superadmin';
export const SUPERADMIN_NAME = 'Local Superadmin';
const DEMO_ACCOUNT = 'dev-local-superadmin-demo';

/** Where the generated password is kept: outside the repository, mode 0600. */
export function superadminPasswordFile(
  env: Record<string, string | undefined>,
): string {
  const dir = env.AGENTCORE_DEV_SECRETS_DIR
    ? resolve(env.AGENTCORE_DEV_SECRETS_DIR)
    : join(homedir(), '.config', 'agentcore');
  return join(dir, 'dev-superadmin.password');
}

export function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

/** The secret file must never land inside the repository working tree. */
export function assertOutsideRepository(file: string, repoRoot: string): void {
  const path = relative(resolve(repoRoot), resolve(file));
  if (path === '' || (!path.startsWith('..') && !path.startsWith('/')))
    throw new Error(
      'Refusing to write a credential file inside the repository',
    );
}

/** Writes a secret readable only by the current user (dir 0700, file 0600). */
export async function writeSecretFile(
  file: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${content}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export type SuperadminStatus = 'created' | 'unchanged' | 'password-reset';

export interface SuperadminResult {
  readonly status: SuperadminStatus;
  readonly tenantId: string;
  readonly operatorId: string;
  /** Set only when a new password was generated and must be stored. */
  readonly password?: string;
}

/**
 * Idempotent: the tenant, operator and credential exist exactly once. The
 * password is generated only when the credential is new or a reset is
 * requested; an existing credential is left untouched.
 */
export async function ensureLocalSuperadmin(
  db: PrismaClient,
  options: {
    reset?: boolean;
    password?: string;
    hash?: (password: string) => Promise<string>;
  } = {},
): Promise<SuperadminResult> {
  const tenant = await db.tenant.upsert({
    where: { slug: SUPERADMIN_TENANT_SLUG },
    create: {
      slug: SUPERADMIN_TENANT_SLUG,
      name: 'Local development tenant (fake data)',
      defaultLocale: 'en',
      supportedLocales: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
      timezone: 'Asia/Tashkent',
      packKey: 'education',
      packVersion: '1',
    },
    update: {},
  });
  const existing = await db.operatorCredential.findUnique({
    where: { email: SUPERADMIN_EMAIL },
    select: { operatorId: true, tenantId: true },
  });
  if (existing && existing.tenantId !== tenant.id)
    throw new Error('The superadmin email belongs to another tenant');
  if (existing && !options.reset)
    return {
      status: 'unchanged',
      tenantId: tenant.id,
      operatorId: existing.operatorId,
    };

  const password = options.password ?? generatePassword();
  const passwordHash = await (options.hash ?? hashPassword)(password);
  const operatorId = await db.$transaction(async (tx) => {
    const operator =
      existing === null
        ? await tx.operator.create({
            data: {
              tenantId: tenant.id,
              displayName: SUPERADMIN_NAME,
              role: 'OWNER',
            },
          })
        : await tx.operator.update({
            where: {
              tenantId_id: { tenantId: tenant.id, id: existing.operatorId },
            },
            data: { role: 'OWNER', isActive: true },
          });
    await tx.operatorCredential.upsert({
      where: { operatorId: operator.id },
      create: {
        tenantId: tenant.id,
        operatorId: operator.id,
        email: SUPERADMIN_EMAIL,
        passwordHash,
      },
      update: { passwordHash, failedAttempts: 0, lockedUntil: null },
    });
    return operator.id;
  });
  return {
    status: existing === null ? 'created' : 'password-reset',
    tenantId: tenant.id,
    operatorId,
    password,
  };
}

const DEMO_CONVERSATIONS = [
  {
    name: 'Demo customer (uz)',
    language: 'uz-Latn',
    text: 'Salom, IELTS kursi haqida operator bilan gaplashmoqchiman.',
    overdue: true,
  },
  {
    name: 'Demo customer (ru)',
    language: 'ru',
    text: 'Здравствуйте, можно поговорить с менеджером про подготовку к IELTS?',
    overdue: false,
  },
  {
    name: 'Demo customer (en)',
    language: 'en',
    text: 'Hello, I would like to speak to a person about the course.',
    overdue: false,
  },
] as const;

/**
 * Optional fictional conversations (clearly labelled fake data) so the inbox
 * is not empty. Skipped when the tenant already has conversations.
 */
export async function ensureDemoConversations(
  db: PrismaClient,
  tenantId: string,
): Promise<number> {
  if ((await db.conversation.count({ where: { tenantId } })) > 0) return 0;
  const account = await db.channelAccount.upsert({
    where: {
      channelType_externalAccountId: {
        channelType: 'telegram',
        externalAccountId: DEMO_ACCOUNT,
      },
    },
    create: {
      tenantId,
      channelType: 'telegram',
      externalAccountId: DEMO_ACCOUNT,
      status: 'ACTIVE',
      agentMode: 'OFF',
      isTestAccount: true,
    },
    update: {},
  });
  if (account.tenantId !== tenantId)
    throw new Error('The demo channel account belongs to another tenant');
  for (const demo of DEMO_CONVERSATIONS) {
    const suffix = randomUUID();
    const contact = await db.contact.create({
      data: {
        tenantId,
        channelAccountId: account.id,
        providerUserId: `demo-${suffix}`,
        name: demo.name,
      },
    });
    const conversation = await db.conversation.create({
      data: {
        tenantId,
        channelAccountId: account.id,
        contactId: contact.id,
        providerChatId: `demo-${suffix}`,
        state: 'WAITING_OPERATOR',
        language: demo.language,
      },
    });
    await db.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        channelAccountId: account.id,
        authorType: 'CUSTOMER',
        direction: 'INBOUND',
        text: demo.text,
        sequence: 1,
        providerChatId: `demo-${suffix}`,
      },
    });
    await db.handover.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        reasonCode: 'CUSTOMER_REQUEST',
        summary: { topic: 'local demo data' },
        slaDueAt: new Date(Date.now() + (demo.overdue ? -5 : 30) * 60_000),
      },
    });
  }
  return DEMO_CONVERSATIONS.length;
}
