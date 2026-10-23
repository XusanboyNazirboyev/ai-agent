import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import {
  CatalogAttributesSchema,
  normalizeCatalogText,
  TenantConfigSchema,
  TenantRetentionSettingsSchema,
} from '@agentcore/shared';
import { createPostgresAdapter } from '../src/persistence/postgres-adapter.js';
import { assertSeedAllowed } from '../src/persistence/seed-safety.js';

loadEnv({ path: resolve(process.cwd(), '../../.env') });

const prisma = new PrismaClient({ adapter: createPostgresAdapter() });
const syncedAt = new Date('2026-01-01T00:00:00.000Z');

const demoTenants = [
  {
    slug: 'demo-travel',
    name: 'Demo tenant one',
    packKey: 'travel-demo',
    packVersion: '1',
    accountId: 'seed-account-travel',
    chatId: 'seed-chat-travel',
    userId: 'seed-user-travel',
    items: [
      {
        id: 'destination-sample',
        itemType: 'destination-demo',
        title: 'Sample destination',
        aliases: [
          { value: 'O‘zbekiston', locale: 'uz-Latn', script: 'Latn' },
          { value: 'Ўзбекистон', locale: 'uz-Cyrl', script: 'Cyrl' },
          { value: 'Узбекистан', locale: 'ru', script: 'Cyrl' },
        ],
      },
      {
        id: 'itinerary-sample',
        itemType: 'itinerary-demo',
        title: 'Sample itinerary',
        aliases: [],
      },
    ],
  },
  {
    slug: 'demo-learning',
    name: 'Demo tenant two',
    packKey: 'learning-demo',
    packVersion: '1',
    accountId: 'seed-account-learning',
    chatId: 'seed-chat-learning',
    userId: 'seed-user-learning',
    items: [
      {
        id: 'program-sample',
        itemType: 'program-demo',
        title: 'Sample program',
        aliases: [
          { value: 'Ta’lim dasturi', locale: 'uz-Latn', script: 'Latn' },
          { value: 'Таълим дастури', locale: 'uz-Cyrl', script: 'Cyrl' },
          { value: 'Учебная программа', locale: 'ru', script: 'Cyrl' },
        ],
      },
      {
        id: 'session-sample',
        itemType: 'session-demo',
        title: 'Sample session',
        aliases: [],
      },
    ],
  },
] as const;

async function seedTenant(demo: (typeof demoTenants)[number]): Promise<void> {
  const tenantConfig = TenantConfigSchema.parse({
    tone: 'Neutral demo data',
  });
  const retentionSettings = TenantRetentionSettingsSchema.parse({});

  const tenant = await prisma.tenant.upsert({
    where: { slug: demo.slug },
    create: {
      slug: demo.slug,
      name: demo.name,
      defaultLocale: 'uz-Latn',
      supportedLocales: ['uz-Latn', 'uz-Cyrl', 'ru'],
      timezone: 'Etc/UTC',
      packKey: demo.packKey,
      packVersion: demo.packVersion,
      enabledCapabilities: ['catalog.search'],
      config: tenantConfig,
      retentionSettings,
    },
    update: {
      name: demo.name,
      packKey: demo.packKey,
      packVersion: demo.packVersion,
      config: tenantConfig,
      retentionSettings,
    },
  });

  const existingChannelAccount = await prisma.channelAccount.findUnique({
    where: {
      channelType_externalAccountId: {
        channelType: 'telegram',
        externalAccountId: demo.accountId,
      },
    },
  });
  if (existingChannelAccount && existingChannelAccount.tenantId !== tenant.id) {
    throw new Error('Seed channel account belongs to a different tenant');
  }

  const channelAccount = await prisma.channelAccount.upsert({
    where: {
      channelType_externalAccountId: {
        channelType: 'telegram',
        externalAccountId: demo.accountId,
      },
    },
    create: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: demo.accountId,
      status: 'DISABLED',
      credentialRef: `secret://seed/${demo.slug}/bot`,
      webhookSecretRef: `secret://seed/${demo.slug}/webhook`,
    },
    update: {
      status: 'DISABLED',
      credentialRef: `secret://seed/${demo.slug}/bot`,
      webhookSecretRef: `secret://seed/${demo.slug}/webhook`,
    },
  });

  await prisma.operator.upsert({
    where: {
      tenantId_telegramUserId: {
        tenantId: tenant.id,
        telegramUserId: `seed-operator-${demo.slug}`,
      },
    },
    create: {
      tenantId: tenant.id,
      displayName: 'Demo operator',
      role: 'OPERATOR',
      telegramUserId: `seed-operator-${demo.slug}`,
    },
    update: { displayName: 'Demo operator', isActive: true },
  });

  const contact = await prisma.contact.upsert({
    where: {
      tenantId_channelAccountId_providerUserId: {
        tenantId: tenant.id,
        channelAccountId: channelAccount.id,
        providerUserId: demo.userId,
      },
    },
    create: {
      tenantId: tenant.id,
      channelAccountId: channelAccount.id,
      providerUserId: demo.userId,
      name: 'Demo customer',
      language: 'uz',
      script: 'Latn',
    },
    update: { name: 'Demo customer', deletedAt: null },
  });

  const conversation = await prisma.conversation.upsert({
    where: {
      tenantId_channelAccountId_providerChatId: {
        tenantId: tenant.id,
        channelAccountId: channelAccount.id,
        providerChatId: demo.chatId,
      },
    },
    create: {
      tenantId: tenant.id,
      channelAccountId: channelAccount.id,
      contactId: contact.id,
      providerChatId: demo.chatId,
      state: 'BOT_ACTIVE',
      language: 'uz',
      script: 'Latn',
    },
    update: { contactId: contact.id, assignedOperatorId: null },
  });

  await prisma.conversationSlots.upsert({
    where: {
      tenantId_conversationId_version: {
        tenantId: tenant.id,
        conversationId: conversation.id,
        version: 1,
      },
    },
    create: {
      tenantId: tenant.id,
      conversationId: conversation.id,
      version: 1,
      slots: { version: 1, slots: {} } as Prisma.InputJsonValue,
    },
    update: { slots: { version: 1, slots: {} } as Prisma.InputJsonValue },
  });

  for (const [index, item] of demo.items.entries()) {
    const attributes = CatalogAttributesSchema.parse({
      fields: { sample: true, fixture: item.id },
    });
    const catalogItem = await prisma.catalogItem.upsert({
      where: {
        tenantId_sourceSystem_sourceEntityId: {
          tenantId: tenant.id,
          sourceSystem: 'phase1-seed',
          sourceEntityId: item.id,
        },
      },
      create: {
        tenantId: tenant.id,
        sourceSystem: 'phase1-seed',
        sourceEntityId: item.id,
        itemType: item.itemType,
        title: item.title,
        normalizedTitle: normalizeCatalogText(item.title),
        description: 'Generated sample data; not a real offering.',
        attributes,
        syncedAt,
        sourceHash: `seed-${item.id}-v1`,
      },
      update: {
        itemType: item.itemType,
        title: item.title,
        normalizedTitle: normalizeCatalogText(item.title),
        attributes,
        syncedAt,
        sourceHash: `seed-${item.id}-v1`,
        status: 'ACTIVE',
        deletedAt: null,
      },
    });

    for (const alias of item.aliases) {
      const normalizedValue = normalizeCatalogText(alias.value);
      await prisma.catalogAlias.upsert({
        where: {
          tenantId_itemId_normalizedValue_locale_script: {
            tenantId: tenant.id,
            itemId: catalogItem.id,
            normalizedValue,
            locale: alias.locale,
            script: alias.script,
          },
        },
        create: {
          tenantId: tenant.id,
          itemId: catalogItem.id,
          value: alias.value,
          normalizedValue,
          locale: alias.locale,
          script: alias.script,
        },
        update: { value: alias.value, normalizerVersion: 1 },
      });
    }

    for (const offer of [
      {
        sourceEntityId: `${item.id}-stale`,
        availabilityStatus: 'AVAILABLE' as const,
        validFrom: new Date('2019-01-01T00:00:00.000Z'),
        validUntil: new Date('2020-01-01T00:00:00.000Z'),
      },
      {
        sourceEntityId: `${item.id}-sold-out`,
        availabilityStatus: 'SOLD_OUT' as const,
        validFrom: syncedAt,
        validUntil: null,
      },
    ]) {
      await prisma.offer.upsert({
        where: {
          tenantId_sourceSystem_sourceEntityId: {
            tenantId: tenant.id,
            sourceSystem: 'phase1-seed',
            sourceEntityId: offer.sourceEntityId,
          },
        },
        create: {
          tenantId: tenant.id,
          itemId: catalogItem.id,
          sourceSystem: 'phase1-seed',
          sourceEntityId: offer.sourceEntityId,
          currency: 'USD',
          price: new Prisma.Decimal(index === 0 ? '0.1' : '0.2'),
          pricingBasis: 'UNSPECIFIED',
          availabilityStatus: offer.availabilityStatus,
          validFrom: offer.validFrom,
          validUntil: offer.validUntil,
          syncedAt,
          sourceHash: `seed-${offer.sourceEntityId}-v1`,
        },
        update: {
          availabilityStatus: offer.availabilityStatus,
          validFrom: offer.validFrom,
          validUntil: offer.validUntil,
          syncedAt,
        },
      });
    }
  }

  await prisma.message.upsert({
    where: {
      tenantId_conversationId_sequence: {
        tenantId: tenant.id,
        conversationId: conversation.id,
        sequence: 1,
      },
    },
    create: {
      tenantId: tenant.id,
      conversationId: conversation.id,
      channelAccountId: channelAccount.id,
      authorType: 'CUSTOMER',
      direction: 'INBOUND',
      type: 'TEXT',
      text: 'This is sample customer text.',
      sequence: 1,
      providerChatId: demo.chatId,
      providerMessageId: `seed-in-${demo.slug}`,
      deliveryState: 'SENT',
    },
    update: { text: 'This is sample customer text.' },
  });

  await prisma.message.upsert({
    where: {
      tenantId_conversationId_sequence: {
        tenantId: tenant.id,
        conversationId: conversation.id,
        sequence: 2,
      },
    },
    create: {
      tenantId: tenant.id,
      conversationId: conversation.id,
      channelAccountId: channelAccount.id,
      authorType: 'BOT',
      direction: 'OUTBOUND',
      type: 'TEXT',
      text: 'This is a sample response with no real offer facts.',
      sequence: 2,
      providerChatId: demo.chatId,
      deliveryState: 'UNKNOWN',
    },
    update: { text: 'This is a sample response with no real offer facts.' },
  });
}

async function main(): Promise<void> {
  assertSeedAllowed();
  for (const demo of demoTenants) await seedTenant(demo);
  console.log('Seeded two demo tenants with generic sample catalog data.');
}

main()
  .catch((error: unknown) => {
    console.error(
      'Seed failed:',
      error instanceof Error ? error.message : 'unknown error',
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
