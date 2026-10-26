import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { LocaleRegistry } from '../core/locales/locale-pack.js';
import { INITIAL_LOCALE_PACKS } from '../locales/locale-packs.js';
import {
  TelegramAmbiguousSendError,
  TelegramApiError,
} from '../channels/telegram/telegram-sender.js';
import type { OperatorNotifier } from './operator-notifier.js';
import { operatorStrings, refLine } from './operator-text.js';
import type { InlineButton } from './telegram-bot-api.js';

export const OPERATOR_NOTIFIER = Symbol('OPERATOR_NOTIFIER');

export interface HandoverQueueEvent {
  readonly outboxId: string;
  readonly tenantId: string;
  readonly type: string;
  readonly payload: Prisma.JsonValue;
}

type HandoverWithContext = Prisma.HandoverGetPayload<{
  include: {
    conversation: {
      include: {
        contact: true;
        channelAccount: { select: { operatorChatId: true } };
      };
    };
    tenant: { select: { defaultLocale: true } };
  };
}>;

const LOCALES = new LocaleRegistry(INITIAL_LOCALE_PACKS);
const HANDOVER_EVENTS = new Set([
  'handover.notify',
  'handover.forward',
  'handover.sla',
  'digest.morning',
]);

export function isHandoverEvent(type: string): boolean {
  return HANDOVER_EVENTS.has(type);
}

export function handoverButtons(
  handoverId: string,
  state: 'WAITING' | 'ACTIVE',
  locale: string,
): InlineButton[][] {
  const t = operatorStrings(locale);
  return state === 'WAITING'
    ? [[{ text: t.take, callbackData: `t:${handoverId}` }]]
    : [
        [
          { text: t.returnToBot, callbackData: `r:${handoverId}` },
          { text: t.close, callbackData: `c:${handoverId}` },
        ],
      ];
}

function field(payload: Prisma.JsonValue, key: string): string | undefined {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const value = (payload as Record<string, Prisma.JsonValue>)[key];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/**
 * Delivers handover traffic to operators through an `OperatorNotifier`:
 * the card, forwarded customer messages and the SLA alert. A handover is
 * marked SENT only after the notifier accepted the card; an unconfigured or
 * rejected operator chat is recorded as FAILED with a code, never as sent.
 */
@Injectable()
export class HandoverNotificationService {
  private readonly logger = new Logger(HandoverNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OPERATOR_NOTIFIER) private readonly notifier: OperatorNotifier,
  ) {}

  async process(event: HandoverQueueEvent): Promise<void> {
    if (event.type === 'handover.notify') {
      const id = field(event.payload, 'handoverId');
      if (id) await this.notify(event.tenantId, id);
    } else if (event.type === 'handover.forward') {
      const id = field(event.payload, 'messageId');
      if (id) await this.forward(event.tenantId, id);
    } else if (event.type === 'digest.morning') {
      await this.digest(event.tenantId, field(event.payload, 'date') ?? '');
    } else if (event.type === 'handover.sla') {
      const id = field(event.payload, 'handoverId');
      if (id) await this.sla(event.tenantId, id);
    }
  }

  /** All retries failed: say so on the handover instead of pretending. */
  async markExhausted(event: HandoverQueueEvent): Promise<void> {
    if (event.type !== 'handover.notify') return;
    const id = field(event.payload, 'handoverId');
    if (!id) return;
    await this.prisma.handover.updateMany({
      where: { id, tenantId: event.tenantId, notificationStatus: 'PENDING' },
      data: {
        notificationStatus: 'FAILED',
        notificationErrorCode: 'retries_exhausted',
      },
    });
  }

  private async load(
    tenantId: string,
    handoverId: string,
  ): Promise<HandoverWithContext | null> {
    return this.prisma.handover.findFirst({
      where: { id: handoverId, tenantId },
      include: {
        conversation: {
          include: {
            contact: true,
            channelAccount: { select: { operatorChatId: true } },
          },
        },
        tenant: { select: { defaultLocale: true } },
      },
    });
  }

  private async notify(tenantId: string, handoverId: string): Promise<void> {
    const handover = await this.load(tenantId, handoverId);
    if (!handover || handover.notificationStatus === 'SENT') return;
    const chatId = handover.conversation.channelAccount.operatorChatId;
    if (!chatId) {
      await this.fail(tenantId, handoverId, 'NO_OPERATOR_CHAT');
      return;
    }
    const locale = handover.tenant.defaultLocale;
    const text = await this.card(tenantId, handover, locale);
    try {
      const posted = await this.notifier.postCard(
        {
          operatorChatId: chatId,
          channelAccountId: handover.conversation.channelAccountId,
        },
        {
          text,
          buttons: handoverButtons(
            handover.id,
            handover.status === 'OPEN' ? 'WAITING' : 'ACTIVE',
            locale,
          ),
        },
      );
      await this.prisma.handover.updateMany({
        where: { id: handover.id, tenantId, notificationStatus: 'PENDING' },
        data: {
          notificationStatus: 'SENT',
          notificationErrorCode: null,
          operatorChatId: chatId,
          operatorMessageId: posted.messageId,
          notifiedAt: new Date(),
        },
      });
    } catch (error) {
      if (
        error instanceof TelegramApiError &&
        error.errorCode !== 429 &&
        error.errorCode < 500
      ) {
        // Chat not found, bot removed, ...: retrying cannot help.
        await this.fail(
          tenantId,
          handoverId,
          `telegram_api_${error.errorCode}`,
        );
        return;
      }
      if (error instanceof TelegramAmbiguousSendError)
        this.logger.warn(
          JSON.stringify({
            event: 'handover.notify_ambiguous',
            tenant: tenantId,
          }),
        );
      throw error;
    }
  }

  private async fail(
    tenantId: string,
    handoverId: string,
    code: string,
  ): Promise<void> {
    await this.prisma.handover.updateMany({
      where: { id: handoverId, tenantId, notificationStatus: 'PENDING' },
      data: { notificationStatus: 'FAILED', notificationErrorCode: code },
    });
    this.logger.warn(
      JSON.stringify({
        event: 'handover.notification_failed',
        tenant: tenantId,
        handover: handoverId,
        code,
      }),
    );
  }

  /** Operator-facing card: reason, contact, language, slots, lead, offers, messages. */
  private async card(
    tenantId: string,
    handover: NonNullable<
      Awaited<ReturnType<HandoverNotificationService['load']>>
    >,
    locale: string,
  ): Promise<string> {
    const t = operatorStrings(locale);
    const conversationId = handover.conversationId;
    const [slots, lead, shown, messages] = await Promise.all([
      this.prisma.conversationSlots.findFirst({
        where: { tenantId, conversationId },
        orderBy: { version: 'desc' },
        select: { slots: true },
      }),
      this.prisma.lead.findFirst({
        where: { tenantId, conversationId },
        select: { score: true, reasonCodes: true },
      }),
      this.prisma.shownOffer.findMany({
        where: { tenantId, conversationId },
        orderBy: { shownAt: 'desc' },
        take: 3,
        select: { offerRef: true, facts: true, quoteRecorded: true },
      }),
      this.prisma.message.findMany({
        where: { tenantId, conversationId, direction: 'INBOUND' },
        orderBy: { sequence: 'desc' },
        take: 3,
        select: { text: true },
      }),
    ]);
    const slotEntries = Object.entries(
      ((slots?.slots as { slots?: Record<string, { value?: unknown }> } | null)
        ?.slots ?? {}) as Record<string, { value?: unknown }>,
    ).map(([key, entry]) => `${key}=${String(entry?.value ?? '')}`);
    const summary = (handover.summary ?? {}) as { unknowns?: string[] };
    const contact = handover.conversation.contact;
    const lines = [
      `${t.handover}: ${handover.reasonCode}`,
      `${t.contact}: ${contact.name ?? '-'}${contact.phone ? ` / ${contact.phone}` : ''}`,
      `${t.language}: ${handover.conversation.language ?? '?'}/${handover.conversation.script ?? '?'}`,
      `${t.slots}: ${slotEntries.join(', ') || t.none}`,
      `${t.lead}: ${lead ? `${lead.score} (${lead.reasonCodes.join(', ')})` : t.none}`,
      `${t.shown}: ${
        shown.length
          ? shown
              .map((s) => `${s.offerRef}${s.quoteRecorded ? ' [quote]' : ''}`)
              .join('; ')
          : t.none
      }`,
      ...(summary.unknowns?.length
        ? [summary.unknowns.slice(0, 3).join('; ')]
        : []),
      `${t.last}:`,
      ...messages.reverse().map((m) => `- ${m.text.slice(0, 160)}`),
      refLine(handover.id),
    ];
    return lines.join('\n').slice(0, 4_000);
  }

  /** Morning digest of hot and warm leads and waiting handovers. */
  private async digest(tenantId: string, date: string): Promise<void> {
    const account = await this.prisma.channelAccount.findFirst({
      where: { tenantId, operatorChatId: { not: null }, status: 'ACTIVE' },
      select: {
        id: true,
        operatorChatId: true,
        tenant: { select: { defaultLocale: true } },
      },
    });
    if (!account?.operatorChatId) return;
    const t = operatorStrings(account.tenant.defaultLocale);
    const since = new Date(Date.now() - 24 * 3_600_000);
    const [leads, waiting] = await Promise.all([
      this.prisma.lead.findMany({
        where: {
          tenantId,
          status: 'NEW',
          score: { in: ['HOT', 'WARM'] },
          updatedAt: { gte: since },
        },
        orderBy: [{ score: 'asc' }, { updatedAt: 'desc' }],
        take: 15,
        select: {
          score: true,
          reasonCodes: true,
          contact: { select: { name: true } },
        },
      }),
      this.prisma.handover.count({ where: { tenantId, status: 'OPEN' } }),
    ]);
    const lines = [
      t.digestTitle(date),
      t.digestWaiting(waiting),
      ...(leads.length === 0
        ? [t.digestEmpty]
        : leads.map(
            (lead) =>
              `${lead.score} ${lead.contact.name ?? '-'}: ${lead.reasonCodes.join(', ')}`,
          )),
    ];
    await this.notifier.postCard(
      { operatorChatId: account.operatorChatId, channelAccountId: account.id },
      { text: lines.join('\n').slice(0, 4_000), buttons: [] },
    );
  }

  private async forward(tenantId: string, messageId: string): Promise<void> {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, tenantId, direction: 'INBOUND' },
      select: { text: true, conversationId: true, channelAccountId: true },
    });
    if (!message) return;
    const handover = await this.prisma.handover.findFirst({
      where: {
        tenantId,
        conversationId: message.conversationId,
        status: { in: ['OPEN', 'TAKEN'] },
      },
      orderBy: { openedAt: 'desc' },
    });
    if (!handover) return;
    if (!handover.operatorChatId || !handover.operatorMessageId) {
      // The card is not posted yet (or failed): retry later, bounded by the queue.
      if (handover.notificationStatus === 'FAILED') return;
      throw new Error('Operator card not posted yet');
    }
    await this.notifier.postThreaded(
      {
        operatorChatId: handover.operatorChatId,
        channelAccountId: message.channelAccountId,
      },
      handover.operatorMessageId,
      `${operatorStrings('en').customer}: ${message.text.slice(0, 1_000)}\n${refLine(handover.id)}`,
    );
  }

  private async sla(tenantId: string, handoverId: string): Promise<void> {
    const handover = await this.load(tenantId, handoverId);
    if (!handover || handover.status !== 'OPEN') return;
    const t = operatorStrings(handover.tenant.defaultLocale);
    const minutes = Math.max(
      1,
      Math.round(
        ((handover.slaDueAt ?? new Date()).getTime() -
          handover.openedAt.getTime()) /
          60_000,
      ),
    );
    if (handover.operatorChatId) {
      await this.notifier.postThreaded(
        {
          operatorChatId: handover.operatorChatId,
          channelAccountId: handover.conversation.channelAccountId,
        },
        handover.operatorMessageId ?? '',
        `${t.slaAlert(minutes)}\n${refLine(handover.id)}`,
      );
    }
    // The customer is told about the delay only if operators were actually
    // reached, and only once; the wording promises neither a time nor a reply.
    if (handover.notificationStatus !== 'SENT' || handover.customerNoticeAt)
      return;
    const packs = LOCALES.all();
    const pack =
      packs.find(
        (p) =>
          p.language === handover.conversation.language &&
          p.script === handover.conversation.script,
      ) ??
      packs.find((p) => p.id === handover.tenant.defaultLocale) ??
      packs[0];
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.handover.updateMany({
        where: {
          id: handover.id,
          tenantId,
          customerNoticeAt: null,
          status: 'OPEN',
        },
        data: { customerNoticeAt: new Date() },
      });
      if (claimed.count !== 1) return;
      const latest = await tx.message.findFirst({
        where: { tenantId, conversationId: handover.conversationId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const notice = await tx.message.create({
        data: {
          tenantId,
          conversationId: handover.conversationId,
          channelAccountId: handover.conversation.channelAccountId,
          authorType: 'BOT',
          direction: 'OUTBOUND',
          type: 'TEXT',
          text: pack.templates.operatorDelayNotice,
          sequence: (latest?.sequence ?? 0) + 1,
          providerChatId: handover.conversation.providerChatId,
          deliveryState: 'PENDING',
          sendIdempotencyKey: `handover-sla-notice:${handover.id}`,
        },
        select: { id: true },
      });
      await tx.outboxEvent.create({
        data: {
          tenantId,
          type: 'telegram.send',
          aggregateType: 'message',
          aggregateId: notice.id,
          idempotencyKey: `telegram.send:${notice.id}`,
          payload: { messageId: notice.id } satisfies Prisma.InputJsonObject,
        },
      });
    });
  }
}
