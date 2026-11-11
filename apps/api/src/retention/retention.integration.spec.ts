/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { ContactErasureService } from './contact-erasure.service.js';
import { RetentionService } from './retention.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env') });

const testDatabase = process.env.TEST_POSTGRES_DATABASE;
if (testDatabase !== 'agentcore_test') {
  throw new Error(
    'Retention integration tests only run against the agentcore_test database',
  );
}

const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;

afterAll(async () => {
  await db.$disconnect();
});

function unique(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

async function createTenant(retentionSettings: object = {}) {
  return db.tenant.create({
    data: {
      slug: unique('ret'),
      name: 'Retention fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Etc/UTC',
      packKey: 'test',
      packVersion: '1',
      retentionSettings,
    },
  });
}

async function createBase(tenantId: string) {
  const account = await db.channelAccount.create({
    data: {
      tenantId,
      channelType: 'telegram',
      externalAccountId: unique('acct'),
      status: 'ACTIVE',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId,
      channelAccountId: account.id,
      providerUserId: unique('user'),
      name: 'Ada Lovelace',
      phone: '+998901234567',
      language: 'en',
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: unique('chat'),
      state: 'CLOSED',
    },
  });
  return { account, contact, conversation };
}

describe('RetentionService (P0.6)', () => {
  it(
    'purges expired and stale inbound events by tenant retention settings',
    { timeout: 15000 },
    async () => {
      const tenant = await createTenant({ inboundEventMinutes: 10 });
      const other = await createTenant({});
      const { account } = await createBase(tenant.id);
      const { account: otherAccount } = await createBase(other.id);
      const now = new Date('2026-11-11T12:00:00Z');

      const expired = await db.inboundEvent.create({
        data: {
          tenantId: tenant.id,
          channelAccountId: account.id,
          providerEventId: unique('ev'),
          redactedPayload: {},
          status: 'PROCESSED',
          receivedAt: new Date('2026-11-11T11:00:00Z'),
          expiresAt: new Date('2026-11-11T11:30:00Z'),
        },
      });
      const staleNoExpiry = await db.inboundEvent.create({
        data: {
          tenantId: tenant.id,
          channelAccountId: account.id,
          providerEventId: unique('ev'),
          redactedPayload: {},
          status: 'FAILED',
          receivedAt: new Date('2026-11-11T11:00:00Z'),
        },
      });
      const recent = await db.inboundEvent.create({
        data: {
          tenantId: tenant.id,
          channelAccountId: account.id,
          providerEventId: unique('ev'),
          redactedPayload: {},
          status: 'PROCESSED',
          receivedAt: new Date('2026-11-11T11:55:00Z'),
        },
      });
      const otherOld = await db.inboundEvent.create({
        data: {
          tenantId: other.id,
          channelAccountId: otherAccount.id,
          providerEventId: unique('ev'),
          redactedPayload: {},
          status: 'PROCESSED',
          receivedAt: new Date('2026-11-11T10:00:00Z'),
          expiresAt: new Date('2026-11-11T10:10:00Z'),
        },
      });

      const service = new RetentionService(prisma);
      const deleted = await service.scanTenant(tenant.id, now);
      expect(deleted).toBe(2);

      await expect(
        db.inboundEvent.findUnique({ where: { id: expired.id } }),
      ).resolves.toBeNull();
      await expect(
        db.inboundEvent.findUnique({ where: { id: staleNoExpiry.id } }),
      ).resolves.toBeNull();
      await expect(
        db.inboundEvent.findUnique({ where: { id: recent.id } }),
      ).resolves.not.toBeNull();
      await expect(
        db.inboundEvent.findUnique({ where: { id: otherOld.id } }),
      ).resolves.not.toBeNull();
    },
  );
});

describe('ContactErasureService (P0.6)', () => {
  it('redacts personal data, hides contact, redacts messages and audits', async () => {
    const tenant = await createTenant({});
    const { account, contact, conversation } = await createBase(tenant.id);
    const msg = await db.message.create({
      data: {
        tenantId: tenant.id,
        conversationId: conversation.id,
        channelAccountId: account.id,
        authorType: 'CUSTOMER',
        direction: 'INBOUND',
        type: 'TEXT',
        text: 'My secret',
        sequence: 1,
        providerChatId: 'chat-1',
        providerMessageId: 'pm-1',
        mediaRef: 'file-id',
        detectedLanguage: 'uz',
      },
    });
    const actor = await db.operator.create({
      data: { tenantId: tenant.id, displayName: 'Owner', role: 'OWNER' },
    });

    const service = new ContactErasureService(prisma);
    const result = await service.erase(tenant.id, contact.id, actor.id);
    expect(result).toMatchObject({
      contactId: contact.id,
      alreadyErased: false,
      conversations: 1,
      messagesRedacted: 1,
    });

    const erased = await db.contact.findUnique({
      where: { tenantId_id: { tenantId: tenant.id, id: contact.id } },
    });
    expect(erased).toMatchObject({
      name: null,
      phone: null,
      language: null,
      script: null,
      consentStatus: 'REVOKED',
      marketingOptOut: true,
    });
    expect(erased?.deletedAt).not.toBeNull();
    expect(erased?.providerUserId).toMatch(/^erased:/);

    const erasedMsg = await db.message.findUnique({
      where: { tenantId_id: { tenantId: tenant.id, id: msg.id } },
    });
    expect(erasedMsg).toMatchObject({
      text: '[erased]',
      mediaRef: null,
      providerMessageId: null,
      detectedLanguage: null,
    });

    const audit = await db.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        action: 'contact.erased',
        entityId: contact.id,
      },
    });
    expect(audit).not.toBeNull();

    const again = await service.erase(tenant.id, contact.id, actor.id);
    expect(again.alreadyErased).toBe(true);
  });

  it('does not erase contacts of another tenant', async () => {
    const a = await createTenant({});
    const b = await createTenant({});
    const { contact } = await createBase(a.id);
    const actor = await db.operator.create({
      data: { tenantId: b.id, displayName: 'Owner B', role: 'OWNER' },
    });
    const service = new ContactErasureService(prisma);
    await expect(service.erase(b.id, contact.id, actor.id)).rejects.toThrow();
    const still = await db.contact.findUnique({
      where: { tenantId_id: { tenantId: a.id, id: contact.id } },
    });
    expect(still?.deletedAt).toBeNull();
  });
});
