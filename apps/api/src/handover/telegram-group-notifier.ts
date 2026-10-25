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
      ...(target.channelAccountId
        ? { channelAccountId: target.channelAccountId }
        : {}),
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
      ...(target.channelAccountId
        ? { channelAccountId: target.channelAccountId }
        : {}),
    });
  }

  updateButtons(
    target: NotifierTarget,
    messageId: string,
    buttons: readonly (readonly InlineButton[])[],
  ): Promise<void> {
    return this.api.editReplyMarkup(
      target.operatorChatId,
      messageId,
      buttons,
      target.channelAccountId,
    );
  }

  acknowledge(
    callbackId: string,
    text: string,
    channelAccountId?: string,
  ): Promise<void> {
    return this.api.answerCallbackQuery(callbackId, text, channelAccountId);
  }
}
