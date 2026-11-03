import type { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import type { AppEnvironment } from '../../config/environment.js';
import { createPostgresAdapter } from '../../persistence/postgres-adapter.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { createGroupLinkCode, groupLinkKey } from './operator-group-link.js';
import {
  normalizeTelegramUpdate,
  type NormalizedTelegramText,
} from './telegram-normalizer.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('requires agentcore_test');
const prisma = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
afterAll(async () => prisma.$disconnect());

const MASTER = randomBytes(32).toString('base64');
const KEY = groupLinkKey(MASTER);

/** `null`: a server without SECRETS_MASTER_KEY. */
function service(master: string | null = MASTER): TelegramWebhookService {
  return new TelegramWebhookService(
    prisma as unknown as PrismaService,
    {
      get: (key: string) =>
        key === 'SECRETS_MASTER_KEY' ? (master ?? undefined) : undefined,
    } as unknown as ConfigService<AppEnvironment, true>,
  );
}

async function account(
  status: 'ACTIVE' | 'DISABLED' = 'ACTIVE',
): Promise<{ tenantId: string; id: string }> {
  const suffix = randomUUID();
  const tenant = await prisma.tenant.create({
    data: {
      slug: `group-link-${suffix}`,
      name: 'Group link fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Etc/UTC',
      packKey: 'integration-test',
      packVersion: '1',
    },
  });
  const row = await prisma.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `telegram-${suffix}`,
      status,
    },
  });
  return { tenantId: tenant.id, id: row.id };
}

function groupStart(chatId: number, code: string): NormalizedTelegramText {
  const update = normalizeTelegramUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: chatId, type: 'supergroup' },
      from: { id: 5 },
      text: `/start@tezda_bot ${code}`,
    },
  });
  if (update.kind !== 'text') throw new Error('expected a text update');
  return update;
}

async function groupOf(id: string): Promise<string | null> {
  return (
    await prisma.channelAccount.findUniqueOrThrow({
      where: { id },
      select: { operatorChatId: true },
    })
  ).operatorChatId;
}

describe('one-click operator group (ADR 036)', () => {
  it('links the group once, audits it, and refuses the same code again', async () => {
    const { tenantId, id } = await account();
    const { code } = createGroupLinkCode(KEY, id, null, new Date());

    await expect(
      service().linkOperatorGroup(id, groupStart(-1001, code)),
    ).resolves.toBe('linked');
    expect(await groupOf(id)).toBe('-1001');
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { tenantId, entityId: id },
    });
    expect(audit).toMatchObject({
      actorType: 'SYSTEM',
      action: 'channel.operator_group_changed',
    });
    expect(audit.safeInputSummary).toEqual({
      configured: true,
      via: 'group_link',
    });

    await expect(
      service().linkOperatorGroup(id, groupStart(-2002, code)),
    ).resolves.toBe('refused');
    expect(await groupOf(id)).toBe('-1001');
  });

  it("refuses another account's code, a disabled bot and a server without the master key", async () => {
    const first = await account();
    const second = await account();
    const firstCode = createGroupLinkCode(KEY, first.id, null, new Date()).code;
    await expect(
      service().linkOperatorGroup(second.id, groupStart(-3003, firstCode)),
    ).resolves.toBe('refused');
    expect(await groupOf(second.id)).toBeNull();

    const disabled = await account('DISABLED');
    const disabledCode = createGroupLinkCode(
      KEY,
      disabled.id,
      null,
      new Date(),
    ).code;
    await expect(
      service().linkOperatorGroup(disabled.id, groupStart(-4004, disabledCode)),
    ).resolves.toBe('refused');

    await expect(
      service(null).linkOperatorGroup(first.id, groupStart(-5005, firstCode)),
    ).resolves.toBe('refused');
    expect(await groupOf(first.id)).toBeNull();
  });

  it('moves an already linked bot to a new group with a fresh code', async () => {
    const { id } = await account();
    await prisma.channelAccount.update({
      where: { id },
      data: { operatorChatId: '-1001' },
    });
    const stale = createGroupLinkCode(KEY, id, null, new Date()).code;
    await expect(
      service().linkOperatorGroup(id, groupStart(-6006, stale)),
    ).resolves.toBe('refused');
    const fresh = createGroupLinkCode(KEY, id, '-1001', new Date()).code;
    await expect(
      service().linkOperatorGroup(id, groupStart(-7007, fresh)),
    ).resolves.toBe('linked');
    expect(await groupOf(id)).toBe('-7007');
  });
});
