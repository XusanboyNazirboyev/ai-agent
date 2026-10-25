import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { HandoverService, type CommandResult } from './handover.service.js';
import { handoverButtons } from './handover-notification.service.js';
import { OPERATOR_NOTIFIER } from './handover-notification.service.js';
import type { OperatorNotifier } from './operator-notifier.js';
import { operatorStrings, parseRef } from './operator-text.js';
import { Inject } from '@nestjs/common';

export type OperatorUpdate =
  | {
      readonly kind: 'callback';
      readonly callbackId: string;
      readonly fromUserId: string;
      readonly chatId: string;
      readonly messageId: string;
      readonly data: string;
    }
  | {
      readonly kind: 'message';
      readonly chatId: string;
      readonly messageId: string;
      readonly fromUserId: string;
      readonly text: string;
      readonly replyToText?: string;
    };

export interface OperatorChannel {
  readonly tenantId: string;
  readonly operatorChatId: string;
  /** The bot's channel account (replies go out through that bot). */
  readonly channelAccountId?: string;
}

const ACTION =
  /^(t|r|c):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

/**
 * Turns operator-group Telegram updates (button presses, replies and slash
 * commands) into handover commands. Only messages in the configured operator
 * chat are considered; the sender must be an active operator of the tenant
 * (matched by Telegram user id); every command carries an idempotency key
 * derived from the Telegram callback or message id, so webhook redeliveries
 * change nothing. A reply to a handover message is delivered to the customer
 * only while that operator owns the conversation.
 */
@Injectable()
export class OperatorUpdateHandler {
  private readonly logger = new Logger(OperatorUpdateHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly handovers: HandoverService,
    @Inject(OPERATOR_NOTIFIER) private readonly notifier: OperatorNotifier,
  ) {}

  async handle(
    channel: OperatorChannel,
    update: OperatorUpdate,
  ): Promise<void> {
    if (update.chatId !== channel.operatorChatId) return;
    const operator = await this.handovers.operatorByTelegram(
      channel.tenantId,
      update.fromUserId,
    );
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: channel.tenantId },
      select: { defaultLocale: true },
    });
    const t = operatorStrings(tenant?.defaultLocale ?? 'en');
    if (update.kind === 'callback') {
      const match = ACTION.exec(update.data);
      if (!match) {
        await this.safeAck(
          update.callbackId,
          t.illegal,
          channel.channelAccountId,
        );
        return;
      }
      if (!operator) {
        await this.safeAck(
          update.callbackId,
          t.forbidden,
          channel.channelAccountId,
        );
        return;
      }
      const [, action, handoverId] = match;
      const base = {
        tenantId: channel.tenantId,
        handoverId,
        operatorId: operator.id,
        idempotencyKey: `tg-cb:${update.callbackId}`,
      };
      const result =
        action === 't'
          ? await this.handovers.takeOver(base)
          : action === 'r'
            ? await this.handovers.returnToBot(base)
            : await this.handovers.close(base);
      await this.safeAck(
        update.callbackId,
        this.describe(result, t),
        channel.channelAccountId,
      );
      if (result.status === 'OK') {
        // The handover's own chat: the button message is the card.
        await this.safe(() =>
          this.notifier.updateButtons(
            {
              operatorChatId: channel.operatorChatId,
              ...(channel.channelAccountId
                ? { channelAccountId: channel.channelAccountId }
                : {}),
            },
            update.messageId,
            action === 't'
              ? handoverButtons(
                  handoverId,
                  'ACTIVE',
                  tenant?.defaultLocale ?? 'en',
                )
              : [],
          ),
        );
      }
      return;
    }
    // Text: only replies to a handover message are commands or customer text.
    const handoverId = parseRef(update.replyToText);
    if (!handoverId) return;
    if (!operator) {
      await this.safe(() =>
        this.notifier.postThreaded(
          {
            operatorChatId: channel.operatorChatId,
            ...(channel.channelAccountId
              ? { channelAccountId: channel.channelAccountId }
              : {}),
          },
          update.messageId,
          t.forbidden,
        ),
      );
      return;
    }
    const known = await this.prisma.handover.findFirst({
      where: {
        id: handoverId,
        tenantId: channel.tenantId,
        operatorChatId: channel.operatorChatId,
      },
      select: { id: true },
    });
    if (!known) return;
    const base = {
      tenantId: channel.tenantId,
      handoverId,
      operatorId: operator.id,
      idempotencyKey: `tg-msg:${update.chatId}:${update.messageId}`,
    };
    const text = update.text.trim();
    const command =
      /^\/(take|return|close|note)(?:@\w+)?(?:\s+([\s\S]*))?$/u.exec(text);
    let result: CommandResult;
    if (command) {
      result =
        command[1] === 'take'
          ? await this.handovers.takeOver(base)
          : command[1] === 'return'
            ? await this.handovers.returnToBot(base)
            : command[1] === 'close'
              ? await this.handovers.close(base)
              : await this.handovers.addNote({
                  ...base,
                  text: command[2] ?? '',
                });
    } else {
      result = await this.handovers.reply({ ...base, text });
    }
    await this.safe(() =>
      this.notifier.postThreaded(
        {
          operatorChatId: channel.operatorChatId,
          ...(channel.channelAccountId
            ? { channelAccountId: channel.channelAccountId }
            : {}),
        },
        update.messageId,
        this.describe(result, t, !command),
      ),
    );
  }

  private describe(
    result: CommandResult,
    t: ReturnType<typeof operatorStrings>,
    reply = false,
  ): string {
    if (result.status === 'DUPLICATE') return t.duplicate;
    if (result.status === 'OK') return reply ? t.replied : t.done;
    switch (result.code) {
      case 'ALREADY_TAKEN':
        return t.alreadyTaken;
      case 'FORBIDDEN':
        return t.forbidden;
      case 'NOT_ASSIGNED':
        return t.notAssigned;
      default:
        return t.illegal;
    }
  }

  private async safeAck(
    callbackId: string,
    text: string,
    channelAccountId?: string,
  ): Promise<void> {
    await this.safe(() =>
      this.notifier.acknowledge(callbackId, text, channelAccountId),
    );
  }

  /** Notifier errors must not fail the webhook: the command already ran. */
  private async safe(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'operator.notifier_error',
          name: (error as Error).name,
        }),
      );
    }
  }
}
