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
import { KnowledgeGapsController } from './knowledge-gaps.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Knowledge gap tests require agentcore_test');
const db = ownerClient();
const app = appClient();
const controller = tenantScoped(
  new KnowledgeGapsController(app as unknown as PrismaService),
);
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

type Role = 'OWNER' | 'OPERATOR';

async function world() {
  const id = randomUUID();
  const t = await db.tenant.create({
    data: {
      slug: `gaps-${id}`,
      name: 'Gaps',
      defaultLocale: 'uz-Latn',
      supportedLocales: ['uz-Latn'],
      timezone: 'Asia/Tashkent',
      packKey: 'general',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: t.id,
      channelType: 'telegram',
      externalAccountId: `gaps-${id}`,
      status: 'ACTIVE',
    },
  });
  const ops = {} as Record<Role, string>;
  for (const role of ['OWNER', 'OPERATOR'] as Role[])
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

  /** One customer message and the turn that answered it. */
  async function asked(
    text: string,
    turn: { outcome: string; handoverReason?: string; daysAgo?: number },
  ) {
    const chat = randomUUID();
    const contact = await db.contact.create({
      data: {
        tenantId: t.id,
        channelAccountId: account.id,
        providerUserId: chat,
      },
    });
    const conversation = await db.conversation.create({
      data: {
        tenantId: t.id,
        channelAccountId: account.id,
        contactId: contact.id,
        providerChatId: chat,
      },
    });
    await db.message.create({
      data: {
        tenantId: t.id,
        conversationId: conversation.id,
        channelAccountId: account.id,
        authorType: 'CUSTOMER',
        direction: 'INBOUND',
        text,
        sequence: 1,
        providerChatId: chat,
      },
    });
    const at = new Date(Date.now() - (turn.daysAgo ?? 0) * 86_400_000);
    return (
      await db.agentTurn.create({
        data: {
          tenantId: t.id,
          conversationId: conversation.id,
          channelAccountId: account.id,
          idempotencyKey: `agent-reply:${conversation.id}:1`,
          attempt: 1,
          mode: 'LIVE',
          status: 'COMMITTED',
          claimToken: 'c',
          leaseExpiresAt: at,
          answeredSequence: 1,
          seenInboundSequence: 1,
          conversationVersion: 1,
          correlationId: randomUUID(),
          outcome: turn.outcome,
          handoverReason: turn.handoverReason ?? null,
          createdAt: at,
        },
      })
    ).id;
  }
  return { tenantId: t.id, as, asked };
}

const status = async (work: () => Promise<unknown>) => {
  try {
    await work();
    return 200;
  } catch (error) {
    return (error as { status?: number }).status ?? 500;
  }
};

const noData = { outcome: 'HANDOVER', handoverReason: 'NO_DATA' };

describe('unanswered questions (ADR 091)', () => {
  it('lists NO_DATA questions once per text, most asked first', async () => {
    const w = await world();
    const a1 = await w.asked('Yetkazib berish bormi?', noData);
    const a2 = await w.asked('  yetkazib   berish bormi? ', noData);
    await w.asked('Parkovka bormi?', noData);
    await w.asked('Narxi qancha?', { outcome: 'ANSWERED' });
    await w.asked('Chegirma bormi?', {
      outcome: 'HANDOVER',
      handoverReason: 'NEGOTIATION',
    });
    await w.asked('Eski savol', { ...noData, daysAgo: 20 });

    const { items } = await controller.list(w.as('OPERATOR'));
    expect(items.map((i) => [i.question, i.count])).toEqual([
      ['yetkazib berish bormi?', 2],
      ['Parkovka bormi?', 1],
    ]);
    expect([...items[0]!.ids].sort()).toEqual([a1, a2].sort());
  });

  it('only managers resolve; a resolved question leaves the list', async () => {
    const w = await world();
    const id = await w.asked('Yetkazib berish bormi?', noData);
    await w.asked('Parkovka bormi?', noData);
    expect(
      await status(() =>
        controller.resolve(w.as('OPERATOR'), {
          ids: [id],
          resolution: 'DISMISSED',
        }),
      ),
    ).toBe(403);
    expect(
      await status(() =>
        controller.resolve(w.as('OWNER'), { ids: [id], resolution: 'LATER' }),
      ),
    ).toBe(400);
    expect(
      await controller.resolve(w.as('OWNER'), {
        ids: [id],
        resolution: 'ANSWERED',
      }),
    ).toEqual({ resolved: 1 });
    // Again: nothing left to resolve.
    expect(
      await controller.resolve(w.as('OWNER'), {
        ids: [id],
        resolution: 'DISMISSED',
      }),
    ).toEqual({ resolved: 0 });
    const { items } = await controller.list(w.as('OWNER'));
    expect(items.map((i) => i.question)).toEqual(['Parkovka bormi?']);
    expect(
      await db.agentTurn.findUniqueOrThrow({
        where: { id },
        select: { gapResolution: true },
      }),
    ).toEqual({ gapResolution: 'ANSWERED' });
  });

  it('never resolves another tenant’s turn', async () => {
    const mine = await world();
    const other = await world();
    const theirs = await other.asked('Yetkazib berish bormi?', noData);
    expect(
      await controller.resolve(mine.as('OWNER'), {
        ids: [theirs],
        resolution: 'DISMISSED',
      }),
    ).toEqual({ resolved: 0 });
    expect((await controller.list(other.as('OWNER'))).items).toHaveLength(1);
  });
});
