import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import {
  CatalogAttributesSchema,
  HandoverSummarySchema,
} from '@agentcore/shared';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { CatalogRepository } from './catalog.repository.js';
import { createPostgresAdapter } from './postgres-adapter.js';
import type { PrismaService } from './prisma.service.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

loadEnv({ path: resolve(process.cwd(), '../../.env') });

const testDatabase = process.env.TEST_POSTGRES_DATABASE;
if (testDatabase !== 'agentcore_test') {
  throw new Error(
    'Integration tests only run against the agentcore_test database',
  );
}

const prisma = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});

function unique(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

async function createTenant(
  slug = unique('tenant'),
): Promise<Awaited<ReturnType<typeof prisma.tenant.create>>> {
  return prisma.tenant.create({
    data: {
      slug,
      name: slug,
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Etc/UTC',
      packKey: 'integration-test',
      packVersion: '1',
    },
  });
}

async function createChannel(
  tenantId: string,
): Promise<Awaited<ReturnType<typeof prisma.channelAccount.create>>> {
  return prisma.channelAccount.create({
    data: {
      tenantId,
      channelType: 'test-channel',
      externalAccountId: unique('account'),
      status: 'ACTIVE',
    },
  });
}

async function createConversation(
  tenantId: string,
  channelAccountId: string,
): Promise<Awaited<ReturnType<typeof prisma.conversation.create>>> {
  const contact = await prisma.contact.create({
    data: {
      tenantId,
      channelAccountId,
      providerUserId: unique('user'),
    },
  });
  return prisma.conversation.create({
    data: {
      tenantId,
      channelAccountId,
      contactId: contact.id,
      providerChatId: unique('chat'),
    },
  });
}

async function createItem(
  tenantId: string,
): Promise<Awaited<ReturnType<typeof prisma.catalogItem.create>>> {
  const title = unique('item');
  return prisma.catalogItem.create({
    data: {
      tenantId,
      sourceSystem: 'integration-test',
      sourceEntityId: unique('entity'),
      itemType: 'test-item',
      title,
      normalizedTitle: title.toLowerCase(),
      attributes: { fields: {} },
      syncedAt: new Date(),
      sourceHash: randomUUID(),
    },
  });
}

async function createMessage(input: {
  tenantId: string;
  channelAccountId: string;
  conversationId: string;
  providerChatId: string;
  providerMessageId?: string;
  sequence: number;
}): Promise<Awaited<ReturnType<typeof prisma.message.create>>> {
  return prisma.message.create({
    data: {
      ...input,
      authorType: 'CUSTOMER',
      direction: 'INBOUND',
      type: 'TEXT',
      text: 'Integration-test message.',
    },
  });
}

async function createInboundEvent(
  tenantId: string,
  channelAccountId: string,
  providerEventId: string,
): Promise<Awaited<ReturnType<typeof prisma.inboundEvent.create>>> {
  return prisma.inboundEvent.create({
    data: {
      tenantId,
      channelAccountId,
      providerEventId,
      redactedPayload: { event: 'synthetic' },
    },
  });
}

describe('PostgreSQL persistence constraints', () => {
  beforeAll(async () => prisma.$connect());
  afterAll(async () => prisma.$disconnect());

  it('rejects cross-tenant foreign keys at the database level', async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const itemA = await createItem(tenantA.id);

    await expect(
      prisma.offer.create({
        data: {
          tenantId: tenantB.id,
          itemId: itemA.id,
          sourceSystem: 'integration-test',
          sourceEntityId: unique('offer'),
          syncedAt: new Date(),
          sourceHash: randomUUID(),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('deduplicates inbound event and message keys, scoped by chat for messages', async () => {
    const tenant = await createTenant();
    const channel = await createChannel(tenant.id);
    const conversationA = await createConversation(tenant.id, channel.id);
    const providerMessageId = unique('provider-message');

    await createInboundEvent(tenant.id, channel.id, 'same-event');
    await expect(
      createInboundEvent(tenant.id, channel.id, 'same-event'),
    ).rejects.toMatchObject({ code: 'P2002' });

    await createMessage({
      tenantId: tenant.id,
      channelAccountId: channel.id,
      conversationId: conversationA.id,
      providerChatId: conversationA.providerChatId,
      providerMessageId,
      sequence: 1,
    });
    await expect(
      createMessage({
        tenantId: tenant.id,
        channelAccountId: channel.id,
        conversationId: conversationA.id,
        providerChatId: conversationA.providerChatId,
        providerMessageId,
        sequence: 2,
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const conversationB = await createConversation(tenant.id, channel.id);
    await expect(
      createMessage({
        tenantId: tenant.id,
        channelAccountId: channel.id,
        conversationId: conversationB.id,
        providerChatId: conversationB.providerChatId,
        providerMessageId,
        sequence: 1,
      }),
    ).resolves.toBeDefined();
  });

  it('allows exactly one concurrent insert for a duplicate inbound event key', async () => {
    const tenant = await createTenant();
    const channel = await createChannel(tenant.id);
    const key = unique('concurrent-event');

    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        createInboundEvent(tenant.id, channel.id, key),
      ),
    );
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === 'rejected'),
    ).toHaveLength(3);
  });

  it('enforces sequence uniqueness per conversation', async () => {
    const tenant = await createTenant();
    const channel = await createChannel(tenant.id);
    const conversation = await createConversation(tenant.id, channel.id);
    const message = {
      tenantId: tenant.id,
      channelAccountId: channel.id,
      conversationId: conversation.id,
      providerChatId: conversation.providerChatId,
      sequence: 1,
    };

    await createMessage(message);
    await expect(createMessage(message)).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('allows only one open or taken handover for a conversation', async () => {
    const tenant = await createTenant();
    const channel = await createChannel(tenant.id);
    const conversation = await createConversation(tenant.id, channel.id);
    const summary = HandoverSummarySchema.parse({
      verifiedFacts: [],
      customerClaims: [],
      inferences: [],
      unknowns: [],
    });
    const handover = {
      tenantId: tenant.id,
      conversationId: conversation.id,
      reasonCode: 'NO_MATCH',
      summary,
    } as const;

    await prisma.handover.create({ data: handover });
    await expect(
      prisma.handover.create({ data: handover }),
    ).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('deduplicates outbox actions and keeps audit rows append-only', async () => {
    const tenant = await createTenant();
    const idempotencyKey = unique('outbox-key');
    const outboxEvent = {
      tenantId: tenant.id,
      type: 'fixture.created',
      aggregateType: 'fixture',
      aggregateId: unique('aggregate'),
      idempotencyKey,
      payload: { synthetic: true },
    };
    await prisma.outboxEvent.create({ data: outboxEvent });
    await expect(
      prisma.outboxEvent.create({ data: outboxEvent }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const auditEvent = await prisma.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actorType: 'SYSTEM',
        action: 'fixture.created',
        entityType: 'fixture',
        entityId: unique('audit-entity'),
      },
    });
    await expect(
      prisma.auditEvent.update({
        where: { tenantId_id: { tenantId: tenant.id, id: auditEvent.id } },
        data: { action: 'fixture.changed' },
      }),
    ).rejects.toBeDefined();
  });

  it('stores precise money and enforces offer/quote checks', async () => {
    const tenant = await createTenant();
    const channel = await createChannel(tenant.id);
    const conversation = await createConversation(tenant.id, channel.id);
    const item = await createItem(tenant.id);
    const validFrom = new Date('2026-01-01T00:00:00.000Z');
    const validUntil = new Date('2027-01-01T00:00:00.000Z');
    const offer = await prisma.offer.create({
      data: {
        tenantId: tenant.id,
        itemId: item.id,
        sourceSystem: 'integration-test',
        sourceEntityId: unique('precise-offer'),
        price: new Prisma.Decimal('0.1'),
        currency: 'UZS',
        pricingBasis: 'PER_UNIT',
        validFrom,
        validUntil,
        syncedAt: new Date(),
        sourceHash: randomUUID(),
      },
    });
    const quote = await prisma.quote.create({
      data: {
        tenantId: tenant.id,
        offerId: offer.id,
        conversationId: conversation.id,
        amount: new Prisma.Decimal('0.2'),
        currency: 'UZS',
        pricingBasis: 'PER_UNIT',
        breakdown: { lines: [], taxesIncluded: null, feesIncluded: null },
        sourceSystem: 'integration-test',
        sourceEntityId: unique('quote-source'),
        retrievedAt: new Date(),
        validUntil,
        snapshot: {
          itemTitle: item.title,
          offerFacts: {},
          price: {
            amount: '0.1',
            currency: 'UZS',
            pricingBasis: 'PER_UNIT',
          },
        },
      },
    });
    expect(offer.price?.toString()).toBe('0.1');
    expect(
      quote.amount.add(offer.price ?? new Prisma.Decimal(0)).toString(),
    ).toBe('0.3');

    await expect(
      prisma.offer.create({
        data: {
          tenantId: tenant.id,
          itemId: item.id,
          sourceSystem: 'integration-test',
          sourceEntityId: unique('negative-offer'),
          price: new Prisma.Decimal('-0.01'),
          currency: 'UZS',
          syncedAt: new Date(),
          sourceHash: randomUUID(),
        },
      }),
    ).rejects.toBeDefined();

    await expect(
      prisma.offer.create({
        data: {
          tenantId: tenant.id,
          itemId: item.id,
          sourceSystem: 'integration-test',
          sourceEntityId: unique('invalid-currency'),
          price: new Prisma.Decimal('1'),
          currency: 'ZZZ',
          syncedAt: new Date(),
          sourceHash: randomUUID(),
        },
      }),
    ).rejects.toBeDefined();

    await expect(
      prisma.offer.create({
        data: {
          tenantId: tenant.id,
          itemId: item.id,
          sourceSystem: 'integration-test',
          sourceEntityId: unique('invalid-window'),
          validFrom: validUntil,
          validUntil: validFrom,
          syncedAt: new Date(),
          sourceHash: randomUUID(),
        },
      }),
    ).rejects.toBeDefined();
  });

  it('scopes repository reads and writes to the requested tenant', async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const itemA = await createItem(tenantA.id);
    const itemB = await createItem(tenantB.id);
    const repository = new CatalogRepository(
      prisma as unknown as PrismaService,
    );

    await expect(repository.findById(tenantA.id, itemB.id)).resolves.toBeNull();
    await expect(repository.list(tenantA.id)).resolves.toEqual([itemA]);
    await expect(
      repository.rename(tenantA.id, itemB.id, 'Cross-tenant rename'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      repository.findById(tenantB.id, itemB.id),
    ).resolves.toMatchObject({
      title: itemB.title,
    });
  });

  it('stores idempotent demo data for two distinct tenants', async () => {
    const tenants = await prisma.tenant.findMany({
      where: { slug: { in: ['demo-travel', 'demo-learning'] } },
      orderBy: { slug: 'asc' },
    });
    expect(tenants).toHaveLength(2);
    expect(new Set(tenants.map((tenant) => tenant.packKey)).size).toBe(2);

    for (const tenant of tenants) {
      expect(
        await prisma.catalogItem.count({ where: { tenantId: tenant.id } }),
      ).toBe(2);
      expect(await prisma.offer.count({ where: { tenantId: tenant.id } })).toBe(
        4,
      );
      expect(
        await prisma.conversation.count({ where: { tenantId: tenant.id } }),
      ).toBe(1);
      expect(
        await prisma.message.count({ where: { tenantId: tenant.id } }),
      ).toBe(2);
    }
  });

  it('does not rely on ORM-only configuration for stored JSON validation', () => {
    expect(
      CatalogAttributesSchema.safeParse({ fields: {}, typo: true }).success,
    ).toBe(false);
  });
});
