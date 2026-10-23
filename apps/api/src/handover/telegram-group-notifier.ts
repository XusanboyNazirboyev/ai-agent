import { Injectable } from '@nestjs/common';
import type {
  NotifierTarget,
  OperatorNotifier,
  PostedCard,
} from './operator-notifier.js';
import { TelegramBotApi, type InlineButton } from './telegram-bot-api.js';

/** Delivers operator notifications to a Telegram group through the Bot API. */
@Injectable()
export class TelegramGroupNotifier implements OperatorNotifier {
  readonly kind = 'telegram-group';

  constructor(private readonly api: TelegramBotApi) {}

  postCard(
    target: NotifierTarget,
    card: { text: string; buttons: readonly (readonly InlineButton[])[] },
  ): Promise<PostedCard> {
    return this.api.sendMessage({
      chatId: target.operatorChatId,
      text: card.text,
      buttons: card.buttons,
    });
  }

  postThreaded(
    target: NotifierTarget,
    replyToMessageId: string,
    text: string,
  ): Promise<PostedCard> {
    return this.api.sendMessage({
      chatId: target.operatorChatId,
      text,
      replyToMessageId,
    });
  }

  updateButtons(
    target: NotifierTarget,
    messageId: string,
    buttons: readonly (readonly InlineButton[])[],
  ): Promise<void> {
    return this.api.editReplyMarkup(target.operatorChatId, messageId, buttons);
  }

  acknowledge(callbackId: string, text: string): Promise<void> {
    return this.api.answerCallbackQuery(callbackId, text);
  }
}
