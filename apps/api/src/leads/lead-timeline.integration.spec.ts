/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../persistence/prisma.service.js';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../persistence/testing/test-clients.js';
import { LeadTimelineController, TIMELINE_MESSAGES } from './lead-timeline.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Lead timeline tests require agentcore_test');
// RLS plan S8b: fixtures on the owner; the timeline on the app role under
// the principal's tenant.
const db = ownerClient();
const app = appClient();
const prisma = app as unknown as PrismaService;
const timeline = tenantScoped(new LeadTimelineController(prisma));
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

async function world() {
  const id = randomUUID();
  const t = await db.tenant.create({
    data: {
      slug: `tl-${id}`,
      name: 'T',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: t.id,
      channelType: 'telegram',
      externalAccountId: `t-${id}`,
      status: 'ACTIVE',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: t.id,
      channelAccountId: account.id,
      providerUserId: `u-${id}`,
      name: 'Customer',
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: t.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `c-${id}`,
    },
  });
  const lead = await db.lead.create({
    data: {
      tenantId: t.id,
      contactId: contact.id,
      conversationId: conversation.id,
      score: 'WARM',
      summary: 's',
      idempotencyKey: `l-${id}`,
    },
  });
  const ops: Record<Role, string> = {} as never;
  for (const role of ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'] as Role[])
    ops[role] = (
      await db.operator.create({
        data: { tenantId: t.id, displayName: role, role },
      })
    ).id;
  const as = (role: Role) =>
    ({
      principal: {
        tenantId: t.id,
        operatorId: ops[role],
        role,
        sessionId: 's',
      },
    }) as never;
  return {
    tenantId: t.id,
    leadId: lead.id,
    conversationId: conversation.id,
    channelAccountId: account.id,
    providerChatId: conversation.providerChatId,
    pipelineId: lead.pipelineId,
    ops,
    as,
  };
}

const at = (iso: string) => new Date(iso);

describe('lead activity timeline (P1.7, ADR 069)', () => {
  it('merges stage moves, tasks, notes, handovers and messages, newest first, with names', async () => {
    const w = await world();
    const pipeline = await db.lead.findFirstOrThrow({
      where: { id: w.leadId },
      select: { pipelineId: true },
    });
    const [s1, s2] = await Promise.all(
      ['First', 'Second'].map((name, position) =>
        db.leadStage.create({
          data: {
            tenantId: w.tenantId,
            pipelineId: pipeline.pipelineId,
            name,
            position,
          },
        }),
      ),
    );
    await db.lead.update({
      where: { id: w.leadId },
      data: { createdAt: at('2026-01-01T09:00:00Z') },
    });
    await db.message.create({
      data: {
        tenantId: w.tenantId,
        conversationId: w.conversationId,
        channelAccountId: w.channelAccountId,
        providerChatId: w.providerChatId,
        authorType: 'CUSTOMER',
        direction: 'INBOUND',
        text: `Hello   there\n${'x'.repeat(300)}`,
        sequence: 1,
        createdAt: at('2026-01-01T09:01:00Z'),
      },
    });
    await db.auditEvent.create({
      data: {
        tenantId: w.tenantId,
        actorType: 'OPERATOR',
        actorId: w.ops.OPERATOR,
        action: 'lead.stage.moved',
        entityType: 'lead',
        entityId: w.leadId,
        safeInputSummary: {
          from: s1!.id,
          to: s2!.id,
          actor: 'OPERATOR',
          reasonCodes: '',
        },
        createdAt: at('2026-01-01T10:00:00Z'),
      },
    });
    // An audit row of another lead and an unrelated action stay out.
    await db.auditEvent.create({
      data: {
        tenantId: w.tenantId,
        actorType: 'SYSTEM',
        action: 'lead.stage.moved',
        entityType: 'lead',
        entityId: randomUUID(),
        safeInputSummary: {},
        createdAt: at('2026-01-01T10:30:00Z'),
      },
    });
    await db.leadTask.create({
      data: {
        tenantId: w.tenantId,
        leadId: w.leadId,
        title: 'Call back',
        dueAt: at('2026-01-02T10:00:00Z'),
        createdByOperatorId: w.ops.ADMIN,
        createdAt: at('2026-01-01T11:00:00Z'),
        doneAt: at('2026-01-02T10:05:00Z'),
      },
    });
    await db.internalNote.create({
      data: {
        tenantId: w.tenantId,
        conversationId: w.conversationId,
        operatorId: w.ops.OWNER,
        text: 'VIP customer',
        idempotencyKey: `n-${randomUUID()}`,
        createdAt: at('2026-01-01T12:00:00Z'),
      },
    });
    await db.handover.create({
      data: {
        tenantId: w.tenantId,
        conversationId: w.conversationId,
        reasonCode: 'CUSTOMER_ASKED',
        summary: {},
        status: 'RESOLVED',
        assignedOperatorId: w.ops.OPERATOR,
        openedAt: at('2026-01-01T13:00:00Z'),
        takenAt: at('2026-01-01T13:05:00Z'),
        resolvedAt: at('2026-01-01T14:00:00Z'),
      },
    });

    const { items } = await timeline.timeline(w.as('VIEWER'), w.leadId);
    expect(items.map((i) => i.kind)).toEqual([
      'task.done',
      'handover.resolved',
      'handover.taken',
      'handover.opened',
      'note',
      'task.created',
      'stage.moved',
      'message',
      'lead.created',
    ]);
    const byKind = Object.fromEntries(items.map((i) => [i.kind, i]));
    expect(byKind['stage.moved']).toMatchObject({
      actor: 'operator',
      actorName: 'OPERATOR',
      from: { id: s1!.id, name: 'First' },
      to: { id: s2!.id, name: 'Second' },
    });
    expect(byKind['task.created']).toMatchObject({
      actorName: 'ADMIN',
      text: 'Call back',
    });
    expect(byKind.note).toMatchObject({
      actorName: 'OWNER',
      text: 'VIP customer',
    });
    expect(byKind['handover.opened']).toMatchObject({
      actor: 'assistant',
      reasonCode: 'CUSTOMER_ASKED',
    });
    expect(byKind['handover.taken']?.actorName).toBe('OPERATOR');
    expect(byKind.message?.actor).toBe('customer');
    expect(byKind.message?.text?.startsWith('Hello there x')).toBe(true);
    expect(byKind.message?.text?.length).toBe(120);
    expect(byKind['lead.created']?.actor).toBe('assistant');
  });

  it('keeps to the tenant and caps the messages', async () => {
    const w = await world();
    const other = await world();
    for (let i = 0; i < TIMELINE_MESSAGES + 5; i += 1)
      await db.message.create({
        data: {
          tenantId: w.tenantId,
          conversationId: w.conversationId,
          channelAccountId: w.channelAccountId,
          providerChatId: w.providerChatId,
          authorType: i % 2 ? 'BOT' : 'CUSTOMER',
          direction: i % 2 ? 'OUTBOUND' : 'INBOUND',
          text: `m${i}`,
          sequence: i + 1,
        },
      });
    const { items } = await timeline.timeline(w.as('OPERATOR'), w.leadId);
    expect(items.filter((i) => i.kind === 'message')).toHaveLength(
      TIMELINE_MESSAGES,
    );
    // Another tenant's session never sees this lead.
    await expect(
      timeline.timeline(other.as('OWNER'), w.leadId),
    ).rejects.toMatchObject({ status: 404 });
  });
});
