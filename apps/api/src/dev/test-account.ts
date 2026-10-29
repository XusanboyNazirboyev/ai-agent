import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * Development only, no UI by owner decision (2026-10-28): marks a channel
 * account as a test account, or back. On a test account an untrusted LLM
 * provider may run SHADOW (agent-mode.ts), so the flag decides whether a
 * free-tier provider sees that account's messages. Tenant-checked (the
 * account must belong to the tenant named by its slug) and audited.
 */
export const TEST_ACCOUNT_AUDIT_ACTION = 'channel.test_account_changed';
export const TEST_ACCOUNT_ACTOR = 'dev-script:channel-test-account';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/u;

export interface TestAccountArgs {
  readonly tenantSlug: string;
  readonly accountId: string;
  readonly on: boolean;
}

export const TEST_ACCOUNT_USAGE =
  'Usage: channel:test-account <tenant-slug> <channel-account-uuid> <on|off>';

/** Parses `<tenant-slug> <channel-account-uuid> <on|off>`; throws the usage. */
export function parseTestAccountArgs(argv: readonly string[]): TestAccountArgs {
  const [tenantSlug, accountId, flag, ...rest] = argv;
  if (
    rest.length > 0 ||
    !tenantSlug ||
    !SLUG.test(tenantSlug) ||
    !accountId ||
    !UUID.test(accountId) ||
    (flag !== 'on' && flag !== 'off')
  )
    throw new Error(TEST_ACCOUNT_USAGE);
  return { tenantSlug, accountId: accountId.toLowerCase(), on: flag === 'on' };
}

export interface TestAccountResult {
  readonly status: 'changed' | 'unchanged';
  readonly tenantId: string;
  readonly isTestAccount: boolean;
  readonly agentMode: 'OFF' | 'SHADOW' | 'LIVE';
}

/** Sets the flag; audits only a real change. Unknown tenant or account: throws. */
export async function setTestAccount(
  db: PrismaClient,
  args: TestAccountArgs,
): Promise<TestAccountResult> {
  return db.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { slug: args.tenantSlug },
      select: { id: true },
    });
    const account = tenant
      ? await tx.channelAccount.findFirst({
          where: { id: args.accountId, tenantId: tenant.id },
          select: { isTestAccount: true, agentMode: true },
        })
      : null;
    // One message for both: do not reveal which tenant owns an account.
    if (!tenant || !account)
      throw new Error('No such channel account in that tenant');
    const result = {
      tenantId: tenant.id,
      isTestAccount: args.on,
      agentMode: account.agentMode,
    };
    if (account.isTestAccount === args.on)
      return { status: 'unchanged', ...result };
    await tx.channelAccount.updateMany({
      where: { id: args.accountId, tenantId: tenant.id },
      data: { isTestAccount: args.on },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actorType: 'SYSTEM',
        actorId: TEST_ACCOUNT_ACTOR,
        action: TEST_ACCOUNT_AUDIT_ACTION,
        entityType: 'channel_account',
        entityId: args.accountId,
        safeInputSummary: { from: account.isTestAccount, to: args.on },
      },
    });
    return { status: 'changed', ...result };
  });
}
