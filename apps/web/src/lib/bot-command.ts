/**
 * Telegram sends `/start` (with an optional deep-link code) when someone
 * opens the bot. It is not something the customer wrote, and the code may be
 * a one-time link token, so the inbox shows a label instead of the text.
 */
const START_COMMAND = /^\/start(?:@[A-Za-z0-9_]{1,64})?(?:\s+\S{1,64})?\s*$/u;

export function isStartCommand(text: string | null | undefined): boolean {
  return typeof text === 'string' && START_COMMAND.test(text.trim());
}
