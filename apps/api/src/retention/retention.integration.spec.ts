/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
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
      const tenant = await createTenant({ inboundEventMinutes: 1440 });
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
          receivedAt: new Date('2026-11-09T11:00:00Z'),
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

async function addMessage(
  tenantId: string,
  accountId: string,
  conversationId: string,
  sequence: number,
  createdAt: Date,
  text = 'hello',
  providerChatId = 'chat-x',
) {
  return db.message.create({
    data: {
      tenantId,
      conversationId,
      channelAccountId: accountId,
      authorType: 'CUSTOMER',
      direction: 'INBOUND',
      type: 'TEXT',
      text,
      sequence,
      providerChatId,
      createdAt,
    },
  });
}

async function createQuote(
  tenantId: string,
  conversationId: string,
  shownInMessageId: string | null,
) {
  const title = unique('item');
  const item = await db.catalogItem.create({
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
  const offer = await db.offer.create({
    data: {
      tenantId,
      itemId: item.id,
      sourceSystem: 'integration-test',
      sourceEntityId: unique('offer'),
      price: '1',
      currency: 'UZS',
      pricingBasis: 'PER_UNIT',
      validFrom: new Date('2026-01-01T00:00:00Z'),
      validUntil: new Date('2027-01-01T00:00:00Z'),
      syncedAt: new Date(),
      sourceHash: randomUUID(),
    },
  });
  return db.quote.create({
    data: {
      tenantId,
      offerId: offer.id,
      conversationId,
      shownInMessageId,
      amount: '1',
      currency: 'UZS',
      pricingBasis: 'PER_UNIT',
      breakdown: { lines: [], taxesIncluded: null, feesIncluded: null },
      sourceSystem: 'integration-test',
      sourceEntityId: unique('quote'),
      retrievedAt: new Date(),
      snapshot: { itemTitle: title },
    },
  });
}

async function createAppointment(
  tenantId: string,
  contactId: string,
  conversationId: string,
) {
  const staff = await db.staffMember.create({
    data: { tenantId, displayName: 'Staff', skills: [] },
  });
  const svc = await db.serviceType.create({
    data: {
      tenantId,
      key: 'visit',
      title: 'Visit',
      durationMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      leadTimeMinutes: 0,
      requiredSkills: [],
    },
  });
  const t = new Date('2027-03-01T10:00:00Z');
  return db.appointment.create({
    data: {
      tenantId,
      serviceTypeId: svc.id,
      staffMemberId: staff.id,
      contactId,
      conversationId,
      startsAt: t,
      endsAt: new Date(t.getTime() + 3_600_000),
      blockedFrom: t,
      blockedUntil: new Date(t.getTime() + 3_600_000),
      status: 'CONFIRMED',
      idempotencyKey: unique('appt'),
    },
  });
}

describe('RetentionService message purge (P0.6)', () => {
  it(
    'keeps the newest message of a conversation and detaches dependents',
    { timeout: 30000 },
    async () => {
      const tenant = await createTenant({ messageDays: 30 });
      const other = await createTenant({ messageDays: 30 });
      const { account, conversation } = await createBase(tenant.id);
      const { account: oa, conversation: oc } = await createBase(other.id);
      const old = new Date('2026-01-01T00:00:00Z');
      const now = new Date('2026-11-11T12:00:00Z');
      const msgs = [];
      for (let i = 1; i <= 5; i += 1) {
        msgs.push(
          await addMessage(tenant.id, account.id, conversation.id, i, old),
        );
      }
      const otherMsg = await addMessage(other.id, oa.id, oc.id, 1, old);
      // single old message in another conversation is also the newest: kept
      const solo = await createBase(tenant.id);
      const soloMsg = await addMessage(
        tenant.id,
        solo.account.id,
        solo.conversation.id,
        1,
        old,
      );

      const quote = await createQuote(tenant.id, conversation.id, msgs[0]!.id);
      const turn = await db.followUp.create({
        data: {
          tenantId: tenant.id,
          conversationId: conversation.id,
          ordinal: 1,
          messageId: msgs[1]!.id,
        },
      });
      const shown = await db.shownOffer.create({
        data: {
          tenantId: tenant.id,
          conversationId: conversation.id,
          messageId: msgs[2]!.id,
          offerRef: 'offer-1',
          facts: {},
        },
      });

      const service = new RetentionService(prisma);
      const deleted = await service.scanTenant(tenant.id, now);
      expect(deleted).toBe(4);
      expect(await service.scanTenant(tenant.id, now)).toBe(0);

      const left = await db.message.findMany({
        where: { tenantId: tenant.id, conversationId: conversation.id },
      });
      expect(left.map((m) => m.id)).toEqual([msgs[4]!.id]);
      await expect(
        db.message.findUnique({ where: { id: soloMsg.id } }),
      ).resolves.not.toBeNull();
      await expect(
        db.message.findUnique({ where: { id: otherMsg.id } }),
      ).resolves.not.toBeNull();

      // next inserted message continues the sequence
      const max = await db.message.aggregate({
        where: { tenantId: tenant.id, conversationId: conversation.id },
        _max: { sequence: true },
      });
      expect(max._max.sequence).toBe(5);
      const next = await addMessage(
        tenant.id,
        account.id,
        conversation.id,
        (max._max.sequence ?? 0) + 1,
        now,
      );
      expect(next.sequence).toBe(6);

      await expect(
        db.followUp.findUnique({ where: { id: turn.id } }),
      ).resolves.toMatchObject({ messageId: null });
      await expect(
        db.shownOffer.findUnique({ where: { id: shown.id } }),
      ).resolves.toBeNull();
      await expect(
        db.quote.findUnique({ where: { id: quote.id } }),
      ).resolves.toMatchObject({ shownInMessageId: null });
    },
  );
});

describe('RetentionService conversation purge (P0.6)', () => {
  it(
    'purges 205 old closed empty conversations in one terminating run, keeps leads',
    { timeout: 120000 },
    async () => {
      const tenant = await createTenant({ conversationDays: 30 });
      const {
        account,
        contact,
        conversation: withLead,
      } = await createBase(tenant.id);
      const withMessage = await db.conversation.create({
        data: {
          tenantId: tenant.id,
          channelAccountId: account.id,
          contactId: contact.id,
          providerChatId: unique('chat'),
          state: 'CLOSED',
        },
      });
      await addMessage(tenant.id, account.id, withMessage.id, 1, new Date());
      await db.lead.create({
        data: {
          tenantId: tenant.id,
          contactId: contact.id,
          conversationId: withLead.id,
          summary: 'keep me',
          idempotencyKey: unique('lead'),
        },
      });
      const detached = await db.conversation.create({
        data: {
          tenantId: tenant.id,
          channelAccountId: account.id,
          contactId: contact.id,
          providerChatId: unique('chat'),
          state: 'CLOSED',
        },
      });
      const handover = await db.handover.create({
        data: {
          tenantId: tenant.id,
          conversationId: detached.id,
          reasonCode: 'test',
          summary: {},
        },
      });
      const appt = await createAppointment(tenant.id, contact.id, detached.id);
      const detachedQuote = await createQuote(tenant.id, detached.id, null);
      const rows = Array.from({ length: 205 }, () => ({
        tenantId: tenant.id,
        channelAccountId: account.id,
        contactId: contact.id,
        providerChatId: unique('chat'),
        state: 'CLOSED' as const,
      }));
      await db.conversation.createMany({ data: rows });
      const now = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

      const service = new RetentionService(prisma);
      const deleted = await service.scanTenant(tenant.id, now);
      expect(deleted).toBe(206);
      await expect(
        db.conversation.findUnique({ where: { id: withLead.id } }),
      ).resolves.not.toBeNull();
      await expect(
        db.conversation.findUnique({ where: { id: withMessage.id } }),
      ).resolves.not.toBeNull();
      await expect(
        db.conversation.findUnique({ where: { id: detached.id } }),
      ).resolves.toBeNull();
      await expect(
        db.handover.findUnique({ where: { id: handover.id } }),
      ).resolves.toBeNull();
      expect(await db.lead.count({ where: { tenantId: tenant.id } })).toBe(1);
      await expect(
        db.appointment.findUnique({ where: { id: appt.id } }),
      ).resolves.toMatchObject({ conversationId: null });
      await expect(
        db.quote.findUnique({ where: { id: detachedQuote.id } }),
      ).resolves.toBeNull();
      expect(await service.scanTenant(tenant.id, now)).toBe(0);
    },
  );

  it(
    'a failing conversation is logged and does not stop the others',
    { timeout: 30000 },
    async () => {
      const tenant = await createTenant({ conversationDays: 30 });
      const {
        account,
        contact,
        conversation: bad,
      } = await createBase(tenant.id);
      const good = await db.conversation.create({
        data: {
          tenantId: tenant.id,
          channelAccountId: account.id,
          contactId: contact.id,
          providerChatId: unique('chat'),
          state: 'CLOSED',
        },
      });
      class Flaky extends RetentionService {
        protected override async purgeOneConversation(
          tenantId: string,
          conversationId: string,
        ): Promise<number> {
          if (conversationId === bad.id) throw new Error('boom');
          return super.purgeOneConversation(tenantId, conversationId);
        }
      }
      const service = new Flaky(prisma);
      const warn = vi
        .spyOn(
          (service as unknown as { logger: { warn: (m: string) => void } })
            .logger,
          'warn',
        )
        .mockImplementation(() => undefined);
      const now = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      expect(await service.scanTenant(tenant.id, now)).toBe(1);
      await expect(
        db.conversation.findUnique({ where: { id: bad.id } }),
      ).resolves.not.toBeNull();
      await expect(
        db.conversation.findUnique({ where: { id: good.id } }),
      ).resolves.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]?.[0]);
      expect(logged).toContain('retention.conversation_purge_failed');
      expect(logged).toContain(bad.id);
      expect(logged).not.toContain('boom');
    },
  );
});

describe('ContactErasureService completeness (P0.6, ADR 049)', () => {
  it(
    'clears slots, lead text, handover summary, proposal payload and chat ids, and closes conversations',
    { timeout: 30000 },
    async () => {
      const tenant = await createTenant({});
      const other = await createTenant({});
      const { account, contact, conversation } = await createBase(tenant.id);
      const chatId = 'secret-chat-998901234567';
      await db.conversation.update({
        where: { id: conversation.id },
        data: {
          state: 'OPERATOR_ACTIVE',
          providerChatId: chatId,
          assignedOperatorId: (
            await db.operator.create({
              data: {
                tenantId: tenant.id,
                displayName: 'Op',
                role: 'OPERATOR',
              },
            })
          ).id,
        },
      });
      await addMessage(
        tenant.id,
        account.id,
        conversation.id,
        1,
        new Date(),
        'call +998901234567',
        chatId,
      );
      await db.conversationSlots.create({
        data: {
          tenantId: tenant.id,
          conversationId: conversation.id,
          version: 1,
          slots: { phone: '+998901234567' },
        },
      });
      const lead = await db.lead.create({
        data: {
          tenantId: tenant.id,
          contactId: contact.id,
          conversationId: conversation.id,
          summary: 'Ada wants a quote, phone +998901234567',
          requirements: { phone: '+998901234567' },
          score: 'HOT',
          idempotencyKey: unique('lead'),
        },
      });
      const handover = await db.handover.create({
        data: {
          tenantId: tenant.id,
          conversationId: conversation.id,
          reasonCode: 'test',
          summary: { note: 'Ada +998901234567' },
        },
      });
      const proposal = await db.actionProposal.create({
        data: {
          tenantId: tenant.id,
          conversationId: conversation.id,
          actionKey: unique('ak').slice(0, 40),
          operation: 'book',
          packRef: 'test@1',
          payload: { phone: '+998901234567' },
          digest: 'd'.repeat(64),
          expiresAt: new Date(Date.now() + 3600_000),
          proposedTurnKey: unique('turn'),
        },
      });
      // Another tenant, same provider ids: must be untouched.
      const oa = await db.channelAccount.create({
        data: {
          tenantId: other.id,
          channelType: 'telegram',
          externalAccountId: unique('acct'),
          status: 'ACTIVE',
        },
      });
      const oc = await db.contact.create({
        data: {
          tenantId: other.id,
          channelAccountId: oa.id,
          providerUserId: contact.providerUserId,
          name: 'Other',
        },
      });
      const ocv = await db.conversation.create({
        data: {
          tenantId: other.id,
          channelAccountId: oa.id,
          contactId: oc.id,
          providerChatId: chatId,
          state: 'BOT_ACTIVE',
        },
      });
      const oLead = await db.lead.create({
        data: {
          tenantId: other.id,
          contactId: oc.id,
          conversationId: ocv.id,
          summary: 'other summary',
          requirements: { a: 1 },
          idempotencyKey: unique('lead'),
        },
      });

      const actor = await db.operator.create({
        data: { tenantId: tenant.id, displayName: 'Owner', role: 'OWNER' },
      });
      const service = new ContactErasureService(prisma);
      const result = await service.erase(tenant.id, contact.id, actor.id);
      expect(result.alreadyErased).toBe(false);

      const conv = await db.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
      });
      expect(conv).toMatchObject({ state: 'CLOSED', assignedOperatorId: null });
      expect(conv.version).toBeGreaterThan(1);
      expect(conv.providerChatId).toMatch(/^erased:/);
      const msg = await db.message.findFirstOrThrow({
        where: { conversationId: conversation.id },
      });
      expect(msg.providerChatId).toBe(conv.providerChatId);
      expect(msg.text).toBe('[erased]');
      const slots = await db.conversationSlots.findFirstOrThrow({
        where: { conversationId: conversation.id },
      });
      expect(slots.slots).toEqual({});
      const l = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(l).toMatchObject({ summary: '', requirements: {}, score: 'HOT' });
      const h = await db.handover.findUniqueOrThrow({
        where: { id: handover.id },
      });
      expect(h.summary).toEqual({});
      const p = await db.actionProposal.findUniqueOrThrow({
        where: { id: proposal.id },
      });
      expect(p.payload).toEqual({});
      expect(p.payloadClearedAt).not.toBeNull();

      // No tenant row of this contact still holds the original text/ids.
      const dump = JSON.stringify([conv, msg, slots, l, h, p]);
      expect(dump).not.toContain('998901234567');
      expect(dump).not.toContain(chatId);

      // Other tenant untouched.
      await expect(
        db.contact.findUniqueOrThrow({ where: { id: oc.id } }),
      ).resolves.toMatchObject({ name: 'Other', deletedAt: null });
      await expect(
        db.conversation.findUniqueOrThrow({ where: { id: ocv.id } }),
      ).resolves.toMatchObject({ state: 'BOT_ACTIVE', providerChatId: chatId });
      await expect(
        db.lead.findUniqueOrThrow({ where: { id: oLead.id } }),
      ).resolves.toMatchObject({ summary: 'other summary' });

      // Second erase is a no-op.
      const again = await service.erase(tenant.id, contact.id, actor.id);
      expect(again.alreadyErased).toBe(true);
      await expect(
        db.conversation.findUniqueOrThrow({ where: { id: conversation.id } }),
      ).resolves.toMatchObject({ version: conv.version });

      // The same person writing again starts a NEW contact and conversation
      // (the original provider ids are free again under the unique keys).
      const newContact = await db.contact.create({
        data: {
          tenantId: tenant.id,
          channelAccountId: account.id,
          providerUserId: contact.providerUserId,
        },
      });
      const newConv = await db.conversation.create({
        data: {
          tenantId: tenant.id,
          channelAccountId: account.id,
          contactId: newContact.id,
          providerChatId: chatId,
        },
      });
      expect(newContact.id).not.toBe(contact.id);
      expect(newConv.id).not.toBe(conversation.id);
      expect(newConv.state).toBe('BOT_ACTIVE');
    },
  );
});
