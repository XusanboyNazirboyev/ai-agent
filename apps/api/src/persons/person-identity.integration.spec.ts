import type { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeTelegramUpdate } from '../channels/telegram/telegram-normalizer.js';
import { TelegramWebhookService } from '../channels/telegram/telegram-webhook.service.js';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { backfillPersons } from '../ops/backfill-persons.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { upsertContactWithPerson } from './ensure-contact.js';

loadEnv({ path: resolve(process.cwd(), '../../.env') });

if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Person integration tests require agentcore_test');
}

const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});

beforeAll(async () => db.$connect());
afterAll(async () => db.$disconnect());

async function tenantWithAccount(): Promise<{
  tenantId: string;
  channelAccountId: string;
}> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `person-${suffix}`,
      name: 'Person fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Etc/UTC',
      packKey: 'integration-test',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `person-${suffix}`,
      status: 'ACTIVE',
    },
  });
  return { tenantId: tenant.id, channelAccountId: account.id };
}

let nextId = 5_000_000 + Math.floor(Math.random() * 1_000_000);

function telegramText(
  userId: number,
  text: string,
): Extract<ReturnType<typeof normalizeTelegramUpdate>, { kind: 'text' }> {
  const id = ++nextId;
  const normalized = normalizeTelegramUpdate({
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1_000),
      chat: { id: userId },
      from: { id: userId, first_name: 'Ada' },
      text,
    },
  });
  if (normalized.kind !== 'text') throw new Error('Expected normalized text');
  return normalized;
}

describe('Person above Contact (ADR 052, slice A)', () => {
  it('Telegram intake creates one person for a new user and none for a repeat', async () => {
    const { tenantId, channelAccountId } = await tenantWithAccount();
    const service = new TelegramWebhookService(
      db as unknown as PrismaService,
      {
        get: (key: string) =>
          ({
            TELEGRAM_CHANNEL_ACCOUNT_ID: channelAccountId,
            TELEGRAM_WEBHOOK_SECRET: 'integration-secret',
            TELEGRAM_RATE_LIMIT_PER_MINUTE: 120,
          })[key],
      } as unknown as ConfigService<AppEnvironment, true>,
    );

    await service.accept(channelAccountId, telegramText(42, 'hello'));
    await service.accept(channelAccountId, telegramText(42, 'hello again'));

    const persons = await db.person.findMany({ where: { tenantId } });
    expect(persons).toHaveLength(1);
    expect(persons[0]?.displayName).toBe('Ada');
    const contacts = await db.contact.findMany({ where: { tenantId } });
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.personId).toBe(persons[0]?.id);
  });

  it('concurrent intake for one new user yields one contact and one person', async () => {
    const { tenantId, channelAccountId } = await tenantWithAccount();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        db.$transaction((tx) =>
          upsertContactWithPerson(tx, {
            tenantId,
            channelAccountId,
            providerUserId: 'same-user',
            name: 'Race',
          }),
        ),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await db.contact.count({ where: { tenantId } })).toBe(1);
    expect(await db.person.count({ where: { tenantId } })).toBe(1);
    expect(
      await db.person.count({ where: { tenantId, contacts: { none: {} } } }),
    ).toBe(0);
  });

  it('tolerates and heals a contact that has no person', async () => {
    const { tenantId, channelAccountId } = await tenantWithAccount();
    await db.contact.create({
      data: { tenantId, channelAccountId, providerUserId: 'legacy' },
    });
    await db.$transaction((tx) =>
      upsertContactWithPerson(tx, {
        tenantId,
        channelAccountId,
        providerUserId: 'legacy',
      }),
    );
    expect(await db.person.count({ where: { tenantId } })).toBe(1);
  });

  it('backfill links person-less contacts, is idempotent and tenant-scoped', async () => {
    const a = await tenantWithAccount();
    const b = await tenantWithAccount();
    for (const [tenant, user, name] of [
      [a, 'u1', 'One'],
      [a, 'u2', null],
      [b, 'u3', 'Three'],
    ] as const) {
      await db.contact.create({
        data: {
          tenantId: tenant.tenantId,
          channelAccountId: tenant.channelAccountId,
          providerUserId: user,
          name,
        },
      });
    }

    const first = await backfillPersons(db, {
      tenantId: a.tenantId,
      batchSize: 1,
    });
    expect(first).toMatchObject({ contactsLinked: 2, personsCreated: 2 });
    expect(await db.person.count({ where: { tenantId: a.tenantId } })).toBe(2);
    // Another tenant is untouched by a tenant-scoped run.
    expect(await db.person.count({ where: { tenantId: b.tenantId } })).toBe(0);
    expect(
      await db.contact.count({
        where: { tenantId: b.tenantId, personId: null },
      }),
    ).toBe(1);

    const second = await backfillPersons(db, { tenantId: a.tenantId });
    expect(second).toMatchObject({ contactsLinked: 0, personsCreated: 0 });
    expect(await db.person.count({ where: { tenantId: a.tenantId } })).toBe(2);
    const named = await db.person.findFirst({
      where: { tenantId: a.tenantId, displayName: 'One' },
    });
    expect(named).not.toBeNull();
    expect(named?.primaryPhone).toBeNull();
  });
});
