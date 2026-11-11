/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../persistence/prisma.service.js';
import { RetentionService } from './retention.service.js';

function fakePrisma() {
  const deleted: Array<{ model: string; where: unknown }> = [];
  const updated: Array<{ model: string; where?: unknown; data?: unknown }> = [];
  const tenants = [
    {
      id: 't1',
      retentionSettings: { inboundEventMinutes: 1440 },
    },
  ];
  const inboundBatches = [
    [{ id: 'e1' }, { id: 'e2' }],
    [] as Array<{ id: string }>,
  ];
  const client = {
    tenant: {
      findMany: async () => tenants.splice(0, tenants.length),
    },
    inboundEvent: {
      findMany: async () => inboundBatches.shift() ?? [],
      deleteMany: async (args: { where: { id: { in: string[] } } }) => {
        deleted.push({ model: 'inboundEvent', where: args.where });
        return { count: args.where.id.in.length };
      },
    },
    message: { findMany: async () => [] },
    conversation: { findMany: async () => [] },
    quote: {
      updateMany: async (args: unknown) => {
        updated.push({ model: 'quote', ...(args as object) });
        return { count: 0 };
      },
    },
    agentTurn: {
      updateMany: async (args: unknown) => {
        updated.push({ model: 'agentTurn', ...(args as object) });
        return { count: 0 };
      },
    },
  };
  return { client: client as unknown as PrismaService, deleted, updated };
}

describe('RetentionService (unit, P0.6)', () => {
  it('deletes expired/stale inbound event batches per tenant', async () => {
    const { client, deleted } = fakePrisma();
    const service = new RetentionService(client);
    const count = await service.scanDue(new Date('2026-11-11T12:00:00Z'));
    expect(count).toBe(2);
    expect(deleted).toEqual([
      {
        model: 'inboundEvent',
        where: { tenantId: 't1', id: { in: ['e1', 'e2'] } },
      },
    ]);
  });
});
