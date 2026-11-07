import { z } from 'zod';

const telegramId = z.union([
  z.number().int().safe().transform(String),
  z.string().regex(/^-?\d+$/),
]);

/**
 * Voice note (Bot API `Voice`, read 2026-11-07): file_id, duration in seconds
 * as defined by the sender, optional mime_type and file_size. Downloaded
 * later with getFile (up to 20 MB).
 */
const voiceSchema = z
  .object({
    file_id: z.string().min(1).max(512),
    duration: z.number().int().nonnegative().safe(),
    mime_type: z.string().max(100).optional(),
    file_size: z.number().int().nonnegative().safe().optional(),
  })
  .passthrough();

const updateSchema = z
  .object({
    update_id: z.number().int().nonnegative().safe(),
    message: z
      .object({
        message_id: z.number().int().positive().safe(),
        date: z.number().int().nonnegative().safe(),
        chat: z
          .object({
            id: telegramId,
            type: z.string().max(32).optional(),
          })
          .passthrough(),
        from: z
          .object({
            id: telegramId,
            first_name: z.string().max(200).optional(),
            last_name: z.string().max(200).optional(),
          })
          .passthrough()
          .optional(),
        text: z.string().min(1).max(4_096).optional(),
        /**
         * Voice note (Bot API `Voice`, read 2026-11-07): file_id, duration
         * in seconds as defined by the sender, optional mime_type and
         * file_size. Downloaded later with getFile (up to 20 MB).
         */
        // Checked on its own below: a malformed voice is ignored, not fatal.
        voice: z.unknown().optional(),
        reply_to_message: z
          .object({
            message_id: z.number().int().positive().safe(),
            text: z.string().max(4_096).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    callback_query: z
      .object({
        id: z.string().min(1).max(200),
        from: z.object({ id: telegramId }).passthrough(),
        message: z
          .object({
            message_id: z.number().int().positive().safe(),
            chat: z.object({ id: telegramId }).passthrough(),
          })
          .passthrough()
          .optional(),
        data: z.string().max(200).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type NormalizedTelegramText = {
  kind: 'text';
  updateId: string;
  messageId: string;
  chatId: string;
  userId: string;
  displayName: string | null;
  text: string;
  receivedAt: Date;
  /**
   * Telegram chat type (`private`, `group`, `supergroup`, ...). Only a
   * private chat is a customer conversation (see isPrivateChat).
   */
  chatType?: string;
  /** The message this one replies to (operator-group routing). */
  replyToText?: string;
  /**
   * ADR 042: set for a voice note; `text` is then empty until the note is
   * transcribed by the queue worker.
   */
  voice?: {
    readonly fileId: string;
    readonly durationSeconds: number;
    readonly mimeType: string;
    readonly fileSize?: number;
  };
};

export type NormalizedTelegramCallback = {
  kind: 'callback';
  updateId: string;
  callbackId: string;
  userId: string;
  chatId: string;
  messageId: string;
  data: string;
};

export type NormalizedTelegramUpdate =
  | NormalizedTelegramText
  | NormalizedTelegramCallback
  | { kind: 'unsupported'; updateId: string };

export class InvalidTelegramUpdateError extends Error {
  constructor() {
    super('Malformed Telegram update');
    this.name = 'InvalidTelegramUpdateError';
  }
}

export function normalizeTelegramUpdate(
  input: unknown,
): NormalizedTelegramUpdate {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new InvalidTelegramUpdateError();

  const {
    update_id: updateId,
    message,
    callback_query: callback,
  } = parsed.data;
  if (callback?.message && callback.data) {
    return {
      kind: 'callback',
      updateId: String(updateId),
      callbackId: callback.id,
      userId: callback.from.id,
      chatId: callback.message.chat.id,
      messageId: String(callback.message.message_id),
      data: callback.data,
    };
  }
  const voiceParsed = voiceSchema.safeParse(message?.voice);
  const voice = voiceParsed.success ? voiceParsed.data : undefined;
  if ((!message?.text && !voice) || !message?.from) {
    return { kind: 'unsupported', updateId: String(updateId) };
  }

  const displayName = [message.from.first_name, message.from.last_name]
    .filter(Boolean)
    .join(' ')
    .slice(0, 200);

  return {
    kind: 'text',
    updateId: String(updateId),
    messageId: String(message.message_id),
    chatId: message.chat.id,
    userId: message.from.id,
    displayName: displayName || null,
    text: message.text ?? '',
    receivedAt: new Date(message.date * 1_000),
    ...(voice && !message.text
      ? {
          voice: {
            fileId: voice.file_id,
            durationSeconds: voice.duration,
            // Telegram voice notes are OGG/Opus when the sender gives no type.
            mimeType: (voice.mime_type ?? 'audio/ogg')
              .split(';')[0]!
              .trim()
              .toLowerCase(),
            ...(voice.file_size !== undefined
              ? { fileSize: voice.file_size }
              : {}),
          },
        }
      : {}),
    ...(message.chat.type !== undefined ? { chatType: message.chat.type } : {}),
    ...(message.reply_to_message?.text !== undefined
      ? { replyToText: message.reply_to_message.text }
      : {}),
  };
}

/** A customer conversation: a private chat (updates without a type count as private). */
export function isPrivateChat(update: NormalizedTelegramText): boolean {
  return update.chatType === undefined || update.chatType === 'private';
}
