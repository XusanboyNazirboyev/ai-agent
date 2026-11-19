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
import { OPERATOR_ALERT_EVENT } from '../observability/alerts.service.js';
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
  OPERATOR_ALERT_EVENT,
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
    } else if (event.type === OPERATOR_ALERT_EVENT) {
      await this.alert(event.tenantId, event.payload);
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
        where: { tenantId, conversationId, archivedAt: null },
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
          archivedAt: null,
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

  /** An operator alert (ADR 030) as a plain message in the operator group. */
  private async alert(
    tenantId: string,
    payload: Prisma.JsonValue,
  ): Promise<void> {
    const account = await this.prisma.channelAccount.findFirst({
      where: { tenantId, operatorChatId: { not: null }, status: 'ACTIVE' },
      select: {
        id: true,
        operatorChatId: true,
        tenant: { select: { defaultLocale: true, timezone: true } },
      },
    });
    if (!account?.operatorChatId) return;
    const t = operatorStrings(account.tenant.defaultLocale);
    const kind = field(payload, 'kind');
    const number = (key: string): number | undefined => {
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const value = (payload as Record<string, Prisma.JsonValue>)[key];
        return typeof value === 'number' ? value : undefined;
      }
      return undefined;
    };
    let text: string | undefined;
    let directTo: string | undefined;
    if (kind === 'BUDGET_NEAR_LIMIT') {
      const percent = number('percent');
      const month = field(payload, 'month');
      if (percent !== undefined && month) text = t.alertBudget(percent, month);
    } else if (kind === 'CRM_SYNC_FAILURES') {
      const count = number('count');
      if (count !== undefined) text = t.alertCrmFailures(count);
    } else if (kind === 'LEAD_LIMIT') {
      const percent = number('percent');
      const count = number('count');
      const limit = number('limit');
      if (percent !== undefined && count !== undefined && limit !== undefined)
        text = t.alertLeadLimit(percent, count, limit);
    } else if (kind === 'SUBSCRIPTION_ENDING') {
      const end = new Date(field(payload, 'periodEnd') ?? '');
      const daysLeft = number('daysLeft');
      if (!Number.isNaN(end.getTime()) && daysLeft !== undefined)
        text = t.alertSubscriptionEnding(
          localDate(end, account.tenant.timezone),
          daysLeft,
        );
    } else if (kind === 'TASK_DUE') {
      const taskId = field(payload, 'taskId');
      const task = taskId
        ? await this.prisma.leadTask.findFirst({
            where: { tenantId, id: taskId },
            select: {
              title: true,
              dueAt: true,
              assignee: {
                select: {
                  displayName: true,
                  telegramUserId: true,
                  isActive: true,
                },
              },
              lead: { select: { contact: { select: { name: true } } } },
            },
          })
        : null;
      // The card is plain text (no parse mode), so customer and task text
      // cannot inject markup; control characters are still dropped.
      if (task?.assignee?.isActive && task.assignee.telegramUserId)
        directTo = task.assignee.telegramUserId;
      if (task)
        text = t.taskDue({
          title: plain(task.title),
          lead: plain(task.lead.contact.name ?? '-'),
          assignee: task.assignee ? plain(task.assignee.displayName) : null,
          due: localDateTime(task.dueAt, account.tenant.timezone),
        });
    }
    if (!text) return;
    await this.notifier.postCard(
      { operatorChatId: account.operatorChatId, channelAccountId: account.id },
      { text: text.slice(0, 4_000), buttons: [] },
    );
    if (directTo) await this.ping(directTo, text, account.id);
  }

  /**
   * The same alert as a private message to the task's assignee (ADR 068).
   * A bot can only write to a person who started a chat with it, so any
   * refusal is a normal skip: logged by code only, never thrown (so the
   * group message is not repeated) and never retried.
   */
  private async ping(
    userId: string,
    text: string,
    channelAccountId: string,
  ): Promise<void> {
    try {
      await this.notifier.postDirect(
        userId,
        text.slice(0, 4_000),
        channelAccountId,
      );
    } catch (error) {
      const code =
        error instanceof Error && 'errorCode' in error
          ? String((error as { errorCode: unknown }).errorCode)
          : 'error';
      this.logger.log(`Task reminder direct message skipped (${code})`);
    }
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

/** Untrusted text on one line: control characters become spaces. */
function plain(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
}

/** `DD.MM.YYYY HH:mm` in the tenant's time zone (UTC when the zone is unknown). */
export function localDateTime(instant: Date, timeZone: string): string {
  const format = (zone: string): string => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant);
    const part = (type: string): string =>
      parts.find((entry) => entry.type === type)?.value ?? '';
    return `${part('day')}.${part('month')}.${part('year')} ${part('hour')}:${part('minute')}`;
  };
  try {
    return format(timeZone);
  } catch {
    return format('UTC');
  }
}

/** `DD.MM.YYYY` in the tenant's time zone (UTC when the zone is unknown). */
function localDate(instant: Date, timeZone: string): string {
  const format = (zone: string): string => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).formatToParts(instant);
    const part = (type: string): string =>
      parts.find((entry) => entry.type === type)?.value ?? '';
    return `${part('day')}.${part('month')}.${part('year')}`;
  };
  try {
    return format(timeZone);
  } catch {
    return format('UTC');
  }
}
