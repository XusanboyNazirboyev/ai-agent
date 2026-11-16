import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { metaInboundKey } from '../meta/meta-event-key.js';
import type { NormalizedInstagramText } from './instagram-normalizer.js';
import { currentTenant } from '../../persistence/tenant-context.js';
import { InstagramWebhookService } from './instagram-webhook.service.js';

const TENANT = '00000000-0000-4000-8000-0000000000a1';

const event: NormalizedInstagramText = {
  kind: 'text',
  messageId: 'mid.123',
  accountId: '123456789',
  customerId: '987654321',
  text: 'Salom, narxi qancha?',
  receivedAt: new Date('2026-10-31T10:00:00.000Z'),
};

function makeService(options?: {
  channel?: unknown;
  duplicate?: unknown;
  routed?: unknown;
}): {
  service: InstagramWebhookService;
  prisma: PrismaService & {
    channelAccount: { findUnique: ReturnType<typeof vi.fn> };
  };
  tx: {
    channelAccount: { findFirst: ReturnType<typeof vi.fn> };
    inboundEvent: { create: ReturnType<typeof vi.fn> };
    message: { create: ReturnType<typeof vi.fn> };
    outboxEvent: { create: ReturnType<typeof vi.fn> };
  };
} {
  const tx = {
    channelAccount: {
      findFirst: vi.fn().mockResolvedValue(
        options?.channel === undefined
          ? {
              id: 'channel-1',
              tenantId: TENANT,
              tenant: { retentionSettings: {} },
            }
          : options.channel,
      ),
    },
    inboundEvent: {
      findUnique: vi.fn().mockResolvedValue(options?.duplicate ?? null),
      create: vi.fn().mockResolvedValue({ id: 'inbound-1' }),
      update: vi.fn().mockResolvedValue({ id: 'inbound-1' }),
    },
    contact: {
      upsert: vi
        .fn()
        .mockResolvedValue({ id: 'contact-1', personId: 'person-1' }),
    },
    conversation: {
      upsert: vi.fn().mockResolvedValue({ id: 'conversation-1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    message: {
      findFirst: vi.fn().mockResolvedValue({ sequence: 4 }),
      create: vi.fn().mockResolvedValue({ id: 'message-1' }),
    },
    outboxEvent: {
      create: vi.fn().mockResolvedValue({ id: 'outbox-1' }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const prisma = {
    // RLS plan S5: the account's tenant is found first, across tenants.
    channelAccount: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          options?.routed === undefined ? { tenantId: TENANT } : options.routed,
        ),
    },
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  } as unknown as PrismaService & {
    channelAccount: { findUnique: ReturnType<typeof vi.fn> };
  };
  return { service: new InstagramWebhookService(prisma), prisma, tx };
}

describe('InstagramWebhookService', () => {
  it('persists one tenant-scoped inbound event and outbox row atomically', async () => {
    const { service, prisma, tx } = makeService();
    await expect(service.accept(event)).resolves.toBe('accepted');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.inboundEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT,
          channelAccountId: 'channel-1',
          providerEventId: event.messageId,
        }),
      }),
    );
    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          text: event.text,
          providerMessageId: event.messageId,
          sequence: 5,
        }),
      }),
    );
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'instagram.inbound',
          idempotencyKey: metaInboundKey('instagram', 'channel-1', 'mid.123'),
        }),
      }),
    );
  });

  it('returns duplicate without creating a second message or outbox event', async () => {
    const { service, tx } = makeService({ duplicate: { id: 'already-seen' } });
    await expect(service.accept(event)).resolves.toBe('duplicate');
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('does not accept an unconnected or inactive Instagram account', async () => {
    const { service, tx } = makeService({ channel: null });
    await expect(service.accept(event)).resolves.toBe('unavailable');
    expect(tx.inboundEvent.create).not.toHaveBeenCalled();
  });

  it('runs the intake under the tenant that owns the account (RLS plan S5)', async () => {
    const { service, prisma, tx } = makeService();
    let seen: string | null = null;
    tx.channelAccount.findFirst.mockImplementation(() => {
      seen = currentTenant();
      return Promise.resolve({
        id: 'channel-1',
        tenantId: TENANT,
        tenant: { retentionSettings: {} },
      });
    });
    await expect(service.accept(event)).resolves.toBe('accepted');
    expect(prisma.channelAccount.findUnique).toHaveBeenCalledWith({
      where: {
        channelType_externalAccountId: {
          channelType: 'instagram',
          externalAccountId: event.accountId,
        },
      },
      select: { tenantId: true },
    });
    expect(seen).toBe(TENANT);
    expect(tx.channelAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT }),
      }),
    );
    expect(currentTenant()).toBeNull();
  });

  it('answers an account no tenant owns as unavailable without a transaction', async () => {
    const { service, prisma } = makeService({ routed: null });
    await expect(service.accept(event)).resolves.toBe('unavailable');
    await expect(service.accept(event, 'facebook')).resolves.toBe(
      'unavailable',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects malformed external identifiers before touching persistence', async () => {
    const { service, prisma } = makeService();
    await expect(
      service.accept({ ...event, customerId: 'not-numeric' }),
    ).rejects.toThrow('Instagram account is unavailable');
    expect(prisma.channelAccount.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
