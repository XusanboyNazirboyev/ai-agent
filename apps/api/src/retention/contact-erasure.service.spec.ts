/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../persistence/prisma.service.js';
import { ContactErasureService } from './contact-erasure.service.js';

function fakePrisma(state: {
  contact: { id: string; deletedAt: Date | null } | null;
}) {
  const calls: Array<{ model: string; op: string; args: unknown }> = [];
  const tx = {
    contact: {
      findFirst: async () => state.contact,
      update: async (args: unknown) => {
        calls.push({ model: 'contact', op: 'update', args });
        return {};
      },
    },
    conversation: {
      findMany: async () => [{ id: 'c1' }],
    },
    message: {
      updateMany: async (args: unknown) => {
        calls.push({ model: 'message', op: 'updateMany', args });
        return { count: 3 };
      },
    },
    internalNote: {
      updateMany: async (args: unknown) => {
        calls.push({ model: 'internalNote', op: 'updateMany', args });
        return { count: 1 };
      },
    },
    auditEvent: {
      create: async (args: unknown) => {
        calls.push({ model: 'auditEvent', op: 'create', args });
        return {};
      },
    },
  };
  const client = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
  return { client, calls };
}

describe('ContactErasureService (unit, P0.6)', () => {
  it('redacts personal data, messages and writes audit event', async () => {
    const { client, calls } = fakePrisma({
      contact: { id: 'u1', deletedAt: null },
    });
    const service = new ContactErasureService(client);
    const result = await service.erase('t1', 'u1', 'op1');
    expect(result).toEqual({
      contactId: 'u1',
      alreadyErased: false,
      conversations: 1,
      messagesRedacted: 3,
    });
    expect(
      calls.some((c) => c.model === 'message' && c.op === 'updateMany'),
    ).toBe(true);
    expect(
      calls.some((c) => c.model === 'auditEvent' && c.op === 'create'),
    ).toBe(true);
    const audit = calls.find((c) => c.model === 'auditEvent')!.args as {
      data: { action: string };
    };
    expect(audit.data.action).toBe('contact.erased');
  });

  it('is idempotent for already erased contacts', async () => {
    const { client } = fakePrisma({
      contact: { id: 'u1', deletedAt: new Date() },
    });
    const service = new ContactErasureService(client);
    await expect(service.erase('t1', 'u1', 'op1')).resolves.toEqual({
      contactId: 'u1',
      alreadyErased: true,
      conversations: 0,
      messagesRedacted: 0,
    });
  });

  it('throws when contact is not found in tenant', async () => {
    const { client } = fakePrisma({ contact: null });
    const service = new ContactErasureService(client);
    await expect(service.erase('t1', 'missing', 'op1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
