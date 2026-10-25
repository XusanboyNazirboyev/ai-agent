import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TelegramApiError } from '../channels/telegram/telegram-sender.js';
import type { CrmConnector } from '../connectors/interfaces/crm-connector.js';
import type { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { ConnectorUnavailableError } from '../connectors/interfaces/errors.js';
import { LeadSyncService } from '../leads/lead-sync.service.js';
import { LeadService } from '../leads/lead.service.js';
import { ShownOffersService } from '../leads/shown-offers.service.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { UZ_LATN } from '../locales/locale-packs.js';
import { EDUCATION_PACK } from '../packs/education/education.pack.js';
import { HandoverNotificationService } from './handover-notification.service.js';
import { HandoverSlaService } from './handover-sla.service.js';
import { HandoverService } from './handover.service.js';
import type { NotifierTarget, OperatorNotifier } from './operator-notifier.js';
import { OperatorUpdateHandler } from './operator-update.handler.js';
import type { InlineButton } from './telegram-bot-api.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Phase 5 integration tests require agentcore_test');
}

const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});

/** Records everything the code asks an operator channel to do. */
class FakeNotifier implements OperatorNotifier {
  readonly kind = 'fake';
  cards: Array<{
    target: NotifierTarget;
    text: string;
    buttons: readonly (readonly InlineButton[])[];
  }> = [];
  threaded: Array<{ replyTo: string; text: string }> = [];
  updates: Array<{
    messageId: string;
    buttons: readonly (readonly InlineButton[])[];
  }> = [];
  acks: string[] = [];
  failWith: Error | undefined;
  private n = 100;

  postCard(
    target: NotifierTarget,
    card: { text: string; buttons: readonly (readonly InlineButton[])[] },
  ): Promise<{ messageId: string }> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.cards.push({ target, ...card });
    return Promise.resolve({ messageId: String(++this.n) });
  }
  postThreaded(
    _target: NotifierTarget,
    replyTo: string,
    text: string,
  ): Promise<{ messageId: string }> {
    this.threaded.push({ replyTo, text });
    return Promise.resolve({ messageId: String(++this.n) });
  }
  updateButtons(
    _target: NotifierTarget,
    messageId: string,
    buttons: readonly (readonly InlineButton[])[],
  ): Promise<void> {
    this.updates.push({ messageId, buttons });
    return Promise.resolve();
  }
  acknowledge(_callbackId: string, text: string): Promise<void> {
    this.acks.push(text);
    return Promise.resolve();
  }
}

interface World {
  tenantId: string;
  channelAccountId: string;
  contactId: string;
  conversationId: string;
  handoverId: string;
  op1: string;
  op2: string;
  tg1: string;
  tg2: string;
}

async function world(
  options: {
    operatorChatId?: string | null;
    state?: 'WAITING_OPERATOR' | 'BOT_ACTIVE';
  } = {},
): Promise<World> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `p5-${suffix}`,
      name: 'Phase 5 fixture',
      defaultLocale: 'en',
      supportedLocales: ['en', 'uz-Latn'],
      timezone: 'Asia/Tashkent',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `p5-${suffix}`,
      status: 'ACTIVE',
      operatorChatId:
        options.operatorChatId === undefined
          ? '-100777'
          : options.operatorChatId,
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: `u-${suffix}`,
      name: 'Ali',
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `c-${suffix}`,
      state: options.state ?? 'WAITING_OPERATOR',
      language: 'uz',
      script: 'Latn',
    },
  });
  await db.message.create({
    data: {
      tenantId: tenant.id,
      conversationId: conversation.id,
      channelAccountId: account.id,
      authorType: 'CUSTOMER',
      direction: 'INBOUND',
      text: 'IELTS kursi narxi?',
      sequence: 1,
      providerChatId: `c-${suffix}`,
    },
  });
  await db.conversationSlots.create({
    data: {
      tenantId: tenant.id,
      conversationId: conversation.id,
      version: 1,
      slots: {
        version: 1,
        slots: { subject: { value: 'IELTS', source: 'customer' } },
      },
    },
  });
  const handover = await db.handover.create({
    data: {
      tenantId: tenant.id,
      conversationId: conversation.id,
      reasonCode: 'GUARDRAIL',
      summary: { unknowns: ['reason=GUARDRAIL'] },
      idempotencyKey: `h-${suffix}`,
      slaDueAt: new Date(Date.now() - 1_000),
    },
  });
  const tg1 = `tg1-${suffix}`;
  const tg2 = `tg2-${suffix}`;
  const [o1, o2] = await Promise.all(
    [tg1, tg2].map((telegramUserId, i) =>
      db.operator.create({
        data: {
          tenantId: tenant.id,
          displayName: `op${i}`,
          role: 'OPERATOR',
          telegramUserId,
        },
        select: { id: true },
      }),
    ),
  );
  return {
    tenantId: tenant.id,
    channelAccountId: account.id,
    contactId: contact.id,
    conversationId: conversation.id,
    handoverId: handover.id,
    op1: o1.id,
    op2: o2.id,
    tg1,
    tg2,
  };
}

const event = (
  w: World,
  type: string,
  payload: Record<string, string>,
): {
  outboxId: string;
  tenantId: string;
  type: string;
  payload: Record<string, string>;
} => ({ outboxId: randomUUID(), tenantId: w.tenantId, type, payload });

describe('operator notification', () => {
  it('posts one card with the context and a take-over button, and never twice', async () => {
    const w = await world();
    await db.lead.create({
      data: {
        tenantId: w.tenantId,
        contactId: w.contactId,
        conversationId: w.conversationId,
        score: 'WARM',
        reasonCodes: ['CONCRETE_ITEM'],
        summary: 's',
        idempotencyKey: `lead:${w.conversationId}`,
      },
    });
    const notifier = new FakeNotifier();
    const service = new HandoverNotificationService(prisma, notifier);
    await service.process(
      event(w, 'handover.notify', { handoverId: w.handoverId }),
    );
    await service.process(
      event(w, 'handover.notify', { handoverId: w.handoverId }),
    );
    expect(notifier.cards).toHaveLength(1);
    const card = notifier.cards[0];
    expect(card.target.operatorChatId).toBe('-100777');
    expect(card.text).toContain('GUARDRAIL');
    expect(card.text).toContain('subject=IELTS');
    expect(card.text).toContain('WARM (CONCRETE_ITEM)');
    expect(card.text).toContain('IELTS kursi narxi?');
    expect(card.text).toContain(`ref:${w.handoverId}`);
    expect(card.buttons[0][0].callbackData).toBe(`t:${w.handoverId}`);
    expect(
      Buffer.byteLength(card.buttons[0][0].callbackData),
    ).toBeLessThanOrEqual(64);
    const handover = await db.handover.findFirstOrThrow({
      where: { id: w.handoverId },
    });
    expect(handover).toMatchObject({
      notificationStatus: 'SENT',
      operatorChatId: '-100777',
      operatorMessageId: '101',
    });
    expect(handover.notifiedAt).not.toBeNull();
  });

  it('records FAILED, never SENT, when no operator chat is configured or the chat rejects', async () => {
    const none = await world({ operatorChatId: null });
    const notifier = new FakeNotifier();
    const service = new HandoverNotificationService(prisma, notifier);
    await service.process(
      event(none, 'handover.notify', { handoverId: none.handoverId }),
    );
    expect(notifier.cards).toHaveLength(0);
    expect(
      await db.handover.findFirstOrThrow({ where: { id: none.handoverId } }),
    ).toMatchObject({
      notificationStatus: 'FAILED',
      notificationErrorCode: 'NO_OPERATOR_CHAT',
    });

    const rejected = await world();
    notifier.failWith = new TelegramApiError(400, null);
    await service.process(
      event(rejected, 'handover.notify', { handoverId: rejected.handoverId }),
    );
    expect(
      await db.handover.findFirstOrThrow({
        where: { id: rejected.handoverId },
      }),
    ).toMatchObject({
      notificationStatus: 'FAILED',
      notificationErrorCode: 'telegram_api_400',
    });

    // A transient error is retried by the queue, so it throws and stays PENDING.
    const flaky = await world();
    notifier.failWith = new TelegramApiError(503, null);
    await expect(
      service.process(
        event(flaky, 'handover.notify', { handoverId: flaky.handoverId }),
      ),
    ).rejects.toThrow();
    expect(
      (await db.handover.findFirstOrThrow({ where: { id: flaky.handoverId } }))
        .notificationStatus,
    ).toBe('PENDING');
    await service.markExhausted(
      event(flaky, 'handover.notify', { handoverId: flaky.handoverId }),
    );
    expect(
      await db.handover.findFirstOrThrow({ where: { id: flaky.handoverId } }),
    ).toMatchObject({
      notificationStatus: 'FAILED',
      notificationErrorCode: 'retries_exhausted',
    });
  });

  it('forwards customer messages under the card, and waits when the card is not posted yet', async () => {
    const w = await world();
    const notifier = new FakeNotifier();
    const service = new HandoverNotificationService(prisma, notifier);
    const message = await db.message.findFirstOrThrow({
      where: { conversationId: w.conversationId },
    });
    await expect(
      service.process(event(w, 'handover.forward', { messageId: message.id })),
    ).rejects.toThrow('not posted');
    await service.process(
      event(w, 'handover.notify', { handoverId: w.handoverId }),
    );
    await service.process(
      event(w, 'handover.forward', { messageId: message.id }),
    );
    expect(notifier.threaded).toHaveLength(1);
    expect(notifier.threaded[0].replyTo).toBe('101');
    expect(notifier.threaded[0].text).toContain('IELTS kursi narxi?');
    expect(notifier.threaded[0].text).toContain(`ref:${w.handoverId}`);
  });
});

describe('SLA', () => {
  it('alerts operators once and tells the customer once, only if operators were reached', async () => {
    const reached = await world();
    const unreached = await world({ operatorChatId: null });
    const notifier = new FakeNotifier();
    const service = new HandoverNotificationService(prisma, notifier);
    await service.process(
      event(reached, 'handover.notify', { handoverId: reached.handoverId }),
    );
    await service.process(
      event(unreached, 'handover.notify', { handoverId: unreached.handoverId }),
    );
    const sla = new HandoverSlaService(prisma);
    // Explicit batch: overdue handovers of earlier runs in the shared test
    // database must not push this test's own out of the first 50.
    const first = await sla.scan(new Date(), 100_000);
    expect(first).toBeGreaterThanOrEqual(2);
    expect(await sla.scan(new Date(), 100_000)).toBe(0); // idempotent: compare-and-set
    for (const w of [reached, unreached]) {
      const queued = await db.outboxEvent.findMany({
        where: { tenantId: w.tenantId, type: 'handover.sla' },
      });
      expect(queued).toHaveLength(1);
      await service.process(
        event(w, 'handover.sla', { handoverId: w.handoverId }),
      );
      await service.process(
        event(w, 'handover.sla', { handoverId: w.handoverId }),
      );
    }
    const notices = (w: World): Promise<number> =>
      db.message.count({
        where: {
          conversationId: w.conversationId,
          direction: 'OUTBOUND',
          authorType: 'BOT',
        },
      });
    expect(await notices(reached)).toBe(1);
    expect(await notices(unreached)).toBe(0);
    const notice = await db.message.findFirstOrThrow({
      where: { conversationId: reached.conversationId, direction: 'OUTBOUND' },
    });
    expect(notice.text).toBe(UZ_LATN.templates.operatorDelayNotice);
    expect(notice.text).not.toMatch(/\d/u); // no time promised
    expect(
      notifier.threaded.some((t) =>
        t.text.includes(`ref:${reached.handoverId}`),
      ),
    ).toBe(true);
  });

  it('does not alert a handover that was already taken', async () => {
    const w = await world();
    await db.handover.update({
      where: { id: w.handoverId },
      data: { status: 'TAKEN' },
    });
    expect(
      await new HandoverSlaService(prisma).scan(new Date()),
    ).toBeGreaterThanOrEqual(0);
    expect(
      await db.outboxEvent.count({
        where: { tenantId: w.tenantId, type: 'handover.sla' },
      }),
    ).toBe(0);
  });
});

describe('operator updates from the Telegram group', () => {
  const setup = async (): Promise<{
    w: World;
    handler: OperatorUpdateHandler;
    notifier: FakeNotifier;
    channel: { tenantId: string; operatorChatId: string };
  }> => {
    const w = await world();
    const notifier = new FakeNotifier();
    await new HandoverNotificationService(prisma, notifier).process(
      event(w, 'handover.notify', { handoverId: w.handoverId }),
    );
    return {
      w,
      notifier,
      handler: new OperatorUpdateHandler(
        prisma,
        new HandoverService(prisma),
        notifier,
      ),
      channel: { tenantId: w.tenantId, operatorChatId: '-100777' },
    };
  };
  const press = (
    w: World,
    from: string,
    data: string,
    callbackId = randomUUID(),
  ): Parameters<OperatorUpdateHandler['handle']>[1] => ({
    kind: 'callback',
    callbackId,
    fromUserId: from,
    chatId: '-100777',
    messageId: '101',
    data,
  });

  it('take-over by button: one winner, the loser is told, a redelivery changes nothing', async () => {
    const { w, handler, notifier, channel } = await setup();
    const idA = randomUUID();
    const idB = randomUUID();
    await Promise.all([
      handler.handle(channel, press(w, w.tg1, `t:${w.handoverId}`, idA)),
      handler.handle(channel, press(w, w.tg2, `t:${w.handoverId}`, idB)),
    ]);
    const conversation = await db.conversation.findFirstOrThrow({
      where: { id: w.conversationId },
    });
    expect(conversation.state).toBe('OPERATOR_ACTIVE');
    expect(notifier.acks.filter((a) => a === 'Done')).toHaveLength(1);
    expect(notifier.acks.some((a) => a.includes('Already taken'))).toBe(true);
    expect(notifier.updates).toHaveLength(1);
    expect(notifier.updates[0].buttons[0].map((b) => b.callbackData)).toEqual([
      `r:${w.handoverId}`,
      `c:${w.handoverId}`,
    ]);
    // Telegram redelivers the winner's callback (whoever won): no second change.
    const winnerIsOne = conversation.assignedOperatorId === w.op1;
    const before = conversation.version;
    await handler.handle(
      channel,
      press(
        w,
        winnerIsOne ? w.tg1 : w.tg2,
        `t:${w.handoverId}`,
        winnerIsOne ? idA : idB,
      ),
    );
    expect(
      (
        await db.conversation.findFirstOrThrow({
          where: { id: w.conversationId },
        })
      ).version,
    ).toBe(before);
    expect(notifier.acks.at(-1)).toBe('Already done');
  });

  it('ignores strangers, bad payloads and other chats', async () => {
    const { w, handler, notifier, channel } = await setup();
    await handler.handle(
      channel,
      press(w, 'unknown-user', `t:${w.handoverId}`),
    );
    expect(notifier.acks.at(-1)).toContain('not an active operator');
    await handler.handle(channel, press(w, w.tg1, 'x:garbage'));
    await handler.handle(channel, {
      ...press(w, w.tg1, `t:${w.handoverId}`),
      chatId: '-999',
    });
    expect(
      (
        await db.conversation.findFirstOrThrow({
          where: { id: w.conversationId },
        })
      ).state,
    ).toBe('WAITING_OPERATOR');
  });

  it('delivers replies, notes and commands only through a handover message', async () => {
    const { w, handler, notifier, channel } = await setup();
    await handler.handle(channel, press(w, w.tg1, `t:${w.handoverId}`));
    const replyTo = `Handover: GUARDRAIL\nref:${w.handoverId}`;
    const message = (
      from: string,
      text: string,
      id: string,
      replyToText: string | null = replyTo,
    ): Parameters<OperatorUpdateHandler['handle']>[1] => ({
      kind: 'message',
      chatId: '-100777',
      messageId: id,
      fromUserId: from,
      text,
      ...(replyToText ? { replyToText } : {}),
    });
    // Plain chatter and replies to unrelated messages are ignored.
    await handler.handle(channel, message(w.tg1, 'hello team', '1', null));
    await handler.handle(
      channel,
      message(w.tg1, 'hello', '2', 'no reference here'),
    );
    expect(
      await db.message.count({
        where: { conversationId: w.conversationId, authorType: 'OPERATOR' },
      }),
    ).toBe(0);
    // The owner's reply reaches the customer through the outbound path.
    await handler.handle(
      channel,
      message(w.tg1, 'Salom, men operatorman', '3'),
    );
    const sent = await db.message.findFirstOrThrow({
      where: { conversationId: w.conversationId, authorType: 'OPERATOR' },
    });
    expect(sent).toMatchObject({
      text: 'Salom, men operatorman',
      deliveryState: 'PENDING',
    });
    expect(notifier.threaded.at(-1)?.text).toBe('Sent to the customer');
    // Redelivery of the same Telegram message is not sent twice.
    await handler.handle(
      channel,
      message(w.tg1, 'Salom, men operatorman', '3'),
    );
    expect(
      await db.message.count({
        where: { conversationId: w.conversationId, authorType: 'OPERATOR' },
      }),
    ).toBe(1);
    // Another operator may not speak for the owner.
    await handler.handle(channel, message(w.tg2, 'I interrupt', '4'));
    expect(notifier.threaded.at(-1)?.text).toContain('another operator');
    expect(
      await db.message.count({
        where: { conversationId: w.conversationId, authorType: 'OPERATOR' },
      }),
    ).toBe(1);
    // Notes stay internal.
    await handler.handle(channel, message(w.tg1, '/note call after 5pm', '5'));
    expect(
      await db.internalNote.count({
        where: { conversationId: w.conversationId },
      }),
    ).toBe(1);
    // Return to bot: the operator can no longer speak.
    await handler.handle(channel, message(w.tg1, '/return', '6'));
    expect(
      (
        await db.conversation.findFirstOrThrow({
          where: { id: w.conversationId },
        })
      ).state,
    ).toBe('BOT_ACTIVE');
    await handler.handle(channel, message(w.tg1, 'still here?', '7'));
    expect(
      await db.message.count({
        where: { conversationId: w.conversationId, authorType: 'OPERATOR' },
      }),
    ).toBe(1);
    expect(
      await db.auditEvent.count({
        where: { tenantId: w.tenantId, actorType: 'OPERATOR' },
      }),
    ).toBeGreaterThanOrEqual(4);
  });

  it('never acts on a reference to another tenant’s handover', async () => {
    const { w, handler, channel } = await setup();
    const other = await world();
    await handler.handle(channel, {
      kind: 'message',
      chatId: '-100777',
      messageId: '9',
      fromUserId: w.tg1,
      text: '/close',
      replyToText: `ref:${other.handoverId}`,
    });
    expect(
      (
        await db.conversation.findFirstOrThrow({
          where: { id: other.conversationId },
        })
      ).state,
    ).toBe('WAITING_OPERATOR');
  });
});

describe('leads', () => {
  const slots = (
    v: Record<string, string | number>,
  ): Record<string, { value: string | number }> =>
    Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { value }]));
  const rescore = (
    w: World,
    s: Record<string, string | number>,
    intent?: string,
  ): ReturnType<LeadService['rescoreFromTurn']> =>
    db.$transaction((tx) =>
      new LeadService(prisma).rescoreFromTurn(tx, {
        tenantId: w.tenantId,
        conversationId: w.conversationId,
        slots: slots(s),
        ...(intent ? { intent } : {}),
      }),
    );

  it('creates no lead for a cold conversation, one lead per conversation otherwise', async () => {
    const w = await world({ state: 'BOT_ACTIVE' });
    await db.handover.deleteMany({ where: { tenantId: w.tenantId } });
    expect(await rescore(w, {})).toBeUndefined();
    const warm = await rescore(w, {
      subject: 'IELTS',
      format: 'online',
      preferredTime: 'evening',
    });
    expect(warm).toMatchObject({ level: 'WARM', created: true });
    const again = await rescore(w, {
      subject: 'IELTS',
      format: 'online',
      preferredTime: 'evening',
    });
    expect(again).toMatchObject({ created: false, changed: false });
    const hot = await rescore(
      w,
      { subject: 'IELTS', format: 'online', preferredTime: 'evening' },
      'booking_interest',
    );
    expect(hot).toMatchObject({ level: 'HOT', changed: true });
    expect(
      await db.lead.count({ where: { conversationId: w.conversationId } }),
    ).toBe(1);
    const lead = await db.lead.findFirstOrThrow({
      where: { conversationId: w.conversationId },
    });
    expect(lead.reasonCodes).toEqual(
      expect.arrayContaining([
        'ASKED_TO_BOOK',
        'CONCRETE_ITEM',
        'FORMAT_SPECIFIED',
        'TIME_SPECIFIED',
      ]),
    );
    expect(lead.requirements).toMatchObject({ subject: 'IELTS' });
    // Evidence only accumulates: a later turn without the intent keeps it.
    const later = await rescore(w, {
      subject: 'IELTS',
      format: 'online',
      preferredTime: 'evening',
    });
    expect(later?.level).toBe('HOT');
    // One sync event per distinct state, not per turn.
    const events = await db.outboxEvent.findMany({
      where: { tenantId: w.tenantId, type: 'crm.lead.sync' },
    });
    expect(events.length).toBe(2);
  });

  it('stores a phone only when the contact has none and counts it as evidence', async () => {
    const w = await world({ state: 'BOT_ACTIVE' });
    const service = new LeadService(prisma);
    expect(
      await db.$transaction((tx) =>
        service.capturePhone(tx, w.tenantId, w.contactId, '+998901234567'),
      ),
    ).toBe(true);
    expect(
      await db.$transaction((tx) =>
        service.capturePhone(tx, w.tenantId, w.contactId, '+998000000000'),
      ),
    ).toBe(false);
    expect(
      (await db.contact.findFirstOrThrow({ where: { id: w.contactId } })).phone,
    ).toBe('+998901234567');
    const result = await rescore(w, { subject: 'IELTS' });
    const lead = await db.lead.findFirstOrThrow({
      where: { conversationId: w.conversationId },
    });
    expect(lead.reasonCodes).toContain('PHONE_PROVIDED');
    expect(result?.level).toBe('WARM');
  });

  const connectorStub = (
    impl: CrmConnector['createLead'] | undefined,
  ): TenantConnectorLoader =>
    ({
      create: () =>
        ({
          connectorKey: 'stub',
          capabilities: { createLead: impl !== undefined },
          ...(impl ? { createLead: impl } : {}),
        }) as unknown as CrmConnector,
    }) as unknown as TenantConnectorLoader;
  const withConnector = async (w: World): Promise<void> => {
    await db.tenantConnector.create({
      data: {
        tenantId: w.tenantId,
        connectorKey: 'mock',
        status: 'ACTIVE',
        config: { sourceSystem: 'x' },
      },
    });
  };
  const leadFor = async (w: World): Promise<string> => {
    await db.handover.deleteMany({ where: { tenantId: w.tenantId } });
    await rescore(w, {
      subject: 'IELTS',
      format: 'online',
      preferredTime: 'evening',
    });
    return (
      await db.lead.findFirstOrThrow({
        where: { conversationId: w.conversationId },
      })
    ).id;
  };

  it('keeps the local lead and reports NOT_REQUIRED when the CRM cannot create leads', async () => {
    const w = await world({ state: 'BOT_ACTIVE' });
    await withConnector(w);
    const id = await leadFor(w);
    const sync = new LeadSyncService(prisma, connectorStub(undefined));
    expect(await sync.sync(w.tenantId, id)).toBe('NOT_REQUIRED');
    expect(await db.lead.findFirstOrThrow({ where: { id } })).toMatchObject({
      crmSyncStatus: 'NOT_REQUIRED',
      crmLeadId: null,
      lastErrorCode: 'NO_CRM_CAPABILITY',
    });
  });

  it('syncs to a capable CRM exactly once and never sends invented contact data', async () => {
    const w = await world({ state: 'BOT_ACTIVE' });
    await withConnector(w);
    const id = await leadFor(w);
    const seen: unknown[] = [];
    const sync = new LeadSyncService(
      prisma,
      connectorStub(async (input) => {
        seen.push(input);
        return { crmLeadId: 'crm-1' };
      }),
    );
    expect(await sync.sync(w.tenantId, id)).toBe('SYNCED');
    expect(await sync.sync(w.tenantId, id)).toBe('SKIPPED');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      contact: { name: 'Ali' },
      score: 'WARM',
      reasonCodes: expect.arrayContaining(['CONCRETE_ITEM']),
    });
    expect(
      (seen[0] as { contact: Record<string, unknown> }).contact,
    ).not.toHaveProperty('phone');
    expect(await db.lead.findFirstOrThrow({ where: { id } })).toMatchObject({
      crmSyncStatus: 'SYNCED',
      crmLeadId: 'crm-1',
    });
  });

  it('a CRM outage never loses the lead: FAILED with attempts, retried later, bounded', async () => {
    const w = await world({ state: 'BOT_ACTIVE' });
    await withConnector(w);
    const id = await leadFor(w);
    let healthy = false;
    const sync = new LeadSyncService(
      prisma,
      connectorStub(async () => {
        // A refused connection: provably not applied, so a retry is safe.
        // (An outage with an unclear outcome is covered in lead-sync.integration.spec.ts.)
        if (!healthy)
          throw new ConnectorUnavailableError({
            message: 'down',
            code: 'CONNECTOR_UNAVAILABLE',
            executed: 'no',
          });
        return { crmLeadId: 'crm-2' };
      }),
    );
    expect(await sync.sync(w.tenantId, id)).toBe('FAILED');
    const failed = await db.lead.findFirstOrThrow({ where: { id } });
    expect(failed).toMatchObject({
      crmSyncStatus: 'FAILED',
      lastErrorCode: 'CONNECTOR_UNAVAILABLE',
      attempts: 1,
    });
    expect(failed.nextAttemptAt).not.toBeNull();
    expect(failed.summary).toContain('WARM'); // still fully observable
    // Not due yet: nothing is queued; once due, it is queued exactly once.
    expect(await sync.scanDue(new Date())).toBe(0);
    const due = new Date(failed.nextAttemptAt!.getTime() + 1_000);
    expect(await sync.scanDue(due)).toBe(1);
    expect(await sync.scanDue(due)).toBe(0);
    healthy = true;
    expect(await sync.sync(w.tenantId, id, due)).toBe('SYNCED');
    // Attempts are bounded.
    await db.lead.update({
      where: { id },
      data: {
        crmSyncStatus: 'FAILED',
        attempts: 8,
        nextAttemptAt: new Date(0),
        crmLeadId: null,
      },
    });
    expect(await sync.scanDue(new Date())).toBe(0);
  });
});

describe('offers shown and quotes', () => {
  const OFFER_REF = 'mock-education:offer:ielts-group-weekday';

  async function delivered(
    w: World,
    options: {
      state?: 'SENT' | 'PENDING' | 'FAILED';
      facts: unknown[];
      shown: string[];
      sync?: boolean;
    },
  ): Promise<string> {
    if (options.sync) {
      const item = await db.catalogItem.create({
        data: {
          tenantId: w.tenantId,
          sourceSystem: 'mock-education',
          sourceEntityId: 'edu-ielts-001',
          itemType: 'course',
          title: 'IELTS Preparation',
          normalizedTitle: 'ielts preparation',
          syncedAt: new Date(),
          sourceHash: 'h',
        },
      });
      await db.offer.create({
        data: {
          tenantId: w.tenantId,
          itemId: item.id,
          sourceSystem: 'mock-education',
          sourceEntityId: OFFER_REF,
          syncedAt: new Date(),
          sourceHash: 'h',
        },
      });
    }
    const message = await db.message.create({
      data: {
        tenantId: w.tenantId,
        conversationId: w.conversationId,
        channelAccountId: w.channelAccountId,
        authorType: 'BOT',
        direction: 'OUTBOUND',
        text: 'reply',
        sequence: 50 + Math.floor(Math.random() * 1_000_000),
        providerChatId: 'c',
        deliveryState: options.state ?? 'SENT',
      },
    });
    await db.agentTurn.create({
      data: {
        tenantId: w.tenantId,
        conversationId: w.conversationId,
        channelAccountId: w.channelAccountId,
        idempotencyKey: `k-${randomUUID()}`,
        attempt: 1,
        mode: 'LIVE',
        status: 'COMMITTED',
        claimToken: randomUUID(),
        leaseExpiresAt: new Date(),
        answeredSequence: 1,
        seenInboundSequence: 1,
        conversationVersion: 1,
        inboundEventIds: [],
        correlationId: randomUUID(),
        startedAt: new Date(),
        replyMessageId: message.id,
        facts: options.facts as never,
        shownFactIds: options.shown,
      },
    });
    return message.id;
  }

  const provenance = (
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    tool: 'get_quote',
    connectorKey: 'mock',
    sourceSystem: 'mock-education',
    sourceEntityId: 'quote-1',
    retrievedAt: '2026-10-24T09:00:00.000Z',
    validUntil: '2026-10-24T09:30:00.000Z',
    offerId: OFFER_REF,
    live: true,
    ...extra,
  });
  const quoteFact = (
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: 'F10',
    value: {
      kind: 'price',
      money: { amount: '150.00', currency: 'USD' },
      confirmedQuote: true,
      pricingBasis: 'PER_PERSON',
    },
    provenance: provenance(extra),
  });

  it('records a confirmed quote for a synced offer once, with the exact facts shown', async () => {
    const w = await world();
    const service = new ShownOffersService(prisma);
    const messageId = await delivered(w, {
      facts: [quoteFact()],
      shown: ['F10'],
      sync: true,
    });
    expect(await service.recordDelivered(w.tenantId, messageId)).toBe(1);
    expect(await service.recordDelivered(w.tenantId, messageId)).toBe(0); // retry
    const shown = await db.shownOffer.findFirstOrThrow({
      where: { messageId },
    });
    expect(shown).toMatchObject({
      offerRef: OFFER_REF,
      quoteRecorded: true,
      quoteSkipReason: null,
    });
    expect(shown.offerId).not.toBeNull();
    const quote = await db.quote.findFirstOrThrow({
      where: { shownInMessageId: messageId },
    });
    expect(quote).toMatchObject({
      currency: 'USD',
      pricingBasis: 'PER_PERSON',
      sourceSystem: 'mock-education',
      sourceEntityId: 'quote-1',
      conversationId: w.conversationId,
    });
    expect(quote.amount.toString()).toBe('150');
    expect(quote.validUntil?.toISOString()).toBe('2026-10-24T09:30:00.000Z');
    expect(quote.snapshot).toMatchObject({ id: 'F10' });
    expect(await db.quote.count({ where: { tenantId: w.tenantId } })).toBe(1);
  });

  it('explains why no Quote row exists: unsynced offer, listed price', async () => {
    const w = await world();
    const service = new ShownOffersService(prisma);
    const unsynced = await delivered(w, {
      facts: [quoteFact()],
      shown: ['F10'],
    });
    await service.recordDelivered(w.tenantId, unsynced);
    expect(
      await db.shownOffer.findFirstOrThrow({ where: { messageId: unsynced } }),
    ).toMatchObject({
      quoteRecorded: false,
      quoteSkipReason: 'OFFER_NOT_SYNCED',
    });
    const listed = await delivered(w, {
      facts: [
        {
          id: 'F3',
          value: {
            kind: 'price',
            money: { amount: '150.00', currency: 'USD' },
            confirmedQuote: false,
          },
          provenance: provenance({ tool: 'list_offers', live: false }),
        },
      ],
      shown: ['F3'],
    });
    await service.recordDelivered(w.tenantId, listed);
    expect(
      await db.shownOffer.findFirstOrThrow({ where: { messageId: listed } }),
    ).toMatchObject({
      quoteRecorded: false,
      quoteSkipReason: 'NOT_A_CONFIRMED_QUOTE',
    });
    expect(await db.quote.count({ where: { tenantId: w.tenantId } })).toBe(0);
  });

  it('records nothing for a draft, a pending, a failed or an unreferenced fact', async () => {
    const w = await world();
    const service = new ShownOffersService(prisma);
    for (const state of ['PENDING', 'FAILED'] as const) {
      const id = await delivered(w, {
        state,
        facts: [quoteFact()],
        shown: ['F10'],
        sync: false,
      });
      expect(await service.recordDelivered(w.tenantId, id)).toBe(0);
    }
    // Fact existed in the turn but is not part of the delivered reply.
    const id = await delivered(w, { facts: [quoteFact()], shown: [] });
    expect(await service.recordDelivered(w.tenantId, id)).toBe(0);
    expect(await db.shownOffer.count({ where: { tenantId: w.tenantId } })).toBe(
      0,
    );
  });

  it('stays inside the tenant', async () => {
    const a = await world();
    const b = await world();
    const service = new ShownOffersService(prisma);
    const messageId = await delivered(a, {
      facts: [quoteFact()],
      shown: ['F10'],
      sync: true,
    });
    expect(await service.recordDelivered(b.tenantId, messageId)).toBe(0);
    expect(await db.shownOffer.count({ where: { tenantId: b.tenantId } })).toBe(
      0,
    );
  });

  it('raises the lead once the offer was actually delivered', async () => {
    const w = await world({ state: 'BOT_ACTIVE' });
    await db.handover.deleteMany({ where: { tenantId: w.tenantId } });
    const messageId = await delivered(w, {
      facts: [quoteFact()],
      shown: ['F10'],
      sync: true,
    });
    await new ShownOffersService(prisma).recordDelivered(w.tenantId, messageId);
    const result = await new LeadService(prisma).rescoreConversation(
      w.tenantId,
      w.conversationId,
    );
    expect(result).toMatchObject({ created: true });
    const lead = await db.lead.findFirstOrThrow({
      where: { conversationId: w.conversationId },
    });
    expect(lead.reasonCodes).toEqual(
      expect.arrayContaining(['CONCRETE_ITEM', 'OFFER_SHOWN', 'QUOTE_SHOWN']),
    );
  });
});

describe('the education pack stays valid', () => {
  it('has lead scoring', () => {
    expect(EDUCATION_PACK.leadScoring?.rules.length).toBeGreaterThan(3);
  });
});
