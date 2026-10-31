import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../persistence/prisma.service.js';
import type { NormalizedInstagramText } from './instagram-normalizer.js';
import { InstagramWebhookService } from './instagram-webhook.service.js';

const event: NormalizedInstagramText = {
  kind: 'text',
  messageId: 'mid.123',
  accountId: '123456789',
  customerId: '987654321',
  text: 'Salom, narxi qancha?',
  receivedAt: new Date('2026-10-31T10:00:00.000Z'),
};

function makeService(options?: { channel?: unknown; duplicate?: unknown }): {
  service: InstagramWebhookService;
  prisma: PrismaService;
  tx: {
    inboundEvent: { create: ReturnType<typeof vi.fn> };
    message: { create: ReturnType<typeof vi.fn> };
    outboxEvent: { create: ReturnType<typeof vi.fn> };
  };
} {
  const tx = {
    channelAccount: {
      findFirst: vi.fn().mockResolvedValue(
        options?.channel === undefined
          ? { id: 'channel-1', tenantId: 'tenant-1' }
          : options.channel,
      ),
    },
    inboundEvent: {
      findUnique: vi.fn().mockResolvedValue(options?.duplicate ?? null),
      create: vi.fn().mockResolvedValue({ id: 'inbound-1' }),
      update: vi.fn().mockResolvedValue({ id: 'inbound-1' }),
    },
    contact: {
      upsert: vi.fn().mockResolvedValue({ id: 'contact-1' }),
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
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  } as unknown as PrismaService;
  return { service: new InstagramWebhookService(prisma), prisma, tx };
}

describe('InstagramWebhookService', () => {
  it(
    'persists one tenant-scoped inbound event and outbox row atomically',
    async () => {
      const { service, prisma, tx } = makeService();
      await expect(service.accept(event)).resolves.toBe('accepted');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.inboundEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: 'tenant-1',
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
            idempotencyKey: 'instagram.inbound:channel-1:mid.123',
          }),
        }),
      );
  });

  it(
    'returns duplicate without creating a second message or outbox event',
    async () => {
      const { service, tx } = makeService({ duplicate: { id: 'already-seen' } });
      await expect(service.accept(event)).resolves.toBe('duplicate');
      expect(tx.message.create).not.toHaveBeenCalled();
      expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it(
    'does not accept an unconnected or inactive Instagram account',
    async () => {
      const { service, tx } = makeService({ channel: null });
      await expect(service.accept(event)).resolves.toBe('unavailable');
      expect(tx.inboundEvent.create).not.toHaveBeenCalled();
  });

  it(
    'rejects malformed external identifiers before touching persistence',
    async () => {
      const { service, prisma } = makeService();
      await expect(
        service.accept({ ...event, customerId: 'not-numeric' }),
      ).rejects.toThrow('Instagram account is unavailable');
      expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
