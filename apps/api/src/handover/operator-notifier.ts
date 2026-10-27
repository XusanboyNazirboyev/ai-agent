import type { InlineButton } from './telegram-bot-api.js';

/**
 * Operator notification port (D19). The handover service decides WHAT to
 * tell operators and when; an implementation only delivers it. Telegram
 * group delivery is `TelegramGroupNotifier`; a future web inbox implements
 * the same interface. Nothing here changes conversation ownership.
 */
export interface NotifierTarget {
  /** Where operators are reached (Telegram group chat id for the first one). */
  readonly operatorChatId: string;
  /** The channel account (bot) that reaches them; the environment bot when absent. */
  readonly channelAccountId?: string;
}

export interface PostedCard {
  readonly messageId: string;
}

export interface OperatorNotifier {
  readonly kind: string;
  /** Posts the handover card with its action buttons. */
  postCard(
    target: NotifierTarget,
    card: { text: string; buttons: readonly (readonly InlineButton[])[] },
  ): Promise<PostedCard>;
  /** Posts a message threaded under an existing card. */
  postThreaded(
    target: NotifierTarget,
    replyToMessageId: string,
    text: string,
  ): Promise<PostedCard>;
  /** Replaces the card's buttons (e.g. after take-over). */
  updateButtons(
    target: NotifierTarget,
    messageId: string,
    buttons: readonly (readonly InlineButton[])[],
  ): Promise<void>;
  /** Acknowledges an operator button press. */
  acknowledge(
    callbackId: string,
    text: string,
    channelAccountId?: string,
  ): Promise<void>;
}
