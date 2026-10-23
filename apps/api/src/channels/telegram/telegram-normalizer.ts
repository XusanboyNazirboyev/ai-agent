import { z } from 'zod';

const telegramId = z.union([
  z.number().int().safe().transform(String),
  z.string().regex(/^-?\d+$/),
]);

const updateSchema = z
  .object({
    update_id: z.number().int().nonnegative().safe(),
    message: z
      .object({
        message_id: z.number().int().positive().safe(),
        date: z.number().int().nonnegative().safe(),
        chat: z.object({ id: telegramId }).passthrough(),
        from: z
          .object({
            id: telegramId,
            first_name: z.string().max(200).optional(),
            last_name: z.string().max(200).optional(),
          })
          .passthrough()
          .optional(),
        text: z.string().min(1).max(4_096).optional(),
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
};

export type NormalizedTelegramUpdate =
  NormalizedTelegramText | { kind: 'unsupported'; updateId: string };

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

  const { update_id: updateId, message } = parsed.data;
  if (!message?.text || !message.from) {
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
    text: message.text,
    receivedAt: new Date(message.date * 1_000),
  };
}
