import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../persistence/prisma.service.js';
import { InboxReadService } from './inbox-read.service.js';

describe('InboxReadService conversation timeline', () => {
  it('returns the newest 500 messages in chronological order', async () => {
    const newestFirst = Array.from({ length: 500 }, (_, index) => {
      const sequence = 501 - index;
      return {
        id: `message-${sequence}`,
        authorType: 'CUSTOMER',
        direction: 'INBOUND',
        type: 'TEXT',
        text: `message ${sequence}`,
        voiceStatus: null,
        deliveryState: 'DELIVERED',
        createdAt: new Date(sequence * 1000),
      };
    });

    const messageFindMany = vi.fn().mockResolvedValue(newestFirst);
    const prisma = {
      conversation: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'conversation-1',
          state: 'WAITING_OPERATOR',
          assignedOperatorId: null,
          language: null,
          script: null,
          version: 1,
          contact: {
            name: null,
            phone: null,
            language: null,
            script: null,
          },
          handovers: [],
          leads: [],
        }),
      },
      message: { findMany: messageFindMany },
      internalNote: { findMany: vi.fn().mockResolvedValue([]) },
      shownOffer: { findMany: vi.fn().mockResolvedValue([]) },
      quote: { findMany: vi.fn().mockResolvedValue([]) },
      conversationSlots: { findFirst: vi.fn().mockResolvedValue(null) },
      actionProposal: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    const service = new InboxReadService(prisma);
    const result = await service.view(
      {
        tenantId: 'tenant-1',
        operatorId: 'operator-1',
        role: 'OPERATOR',
        sessionId: 'session-1',
      },
      'conversation-1',
    );

    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          conversationId: 'conversation-1',
        },
        orderBy: [{ sequence: 'desc' }, { id: 'desc' }],
        take: 500,
      }),
    );
    expect(result?.messages).toHaveLength(500);
    expect(result?.messages[0]?.id).toBe('message-2');
    expect(result?.messages.at(-1)?.id).toBe('message-501');
  });
});
