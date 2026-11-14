/**
 * A BotFather token is numbers, a colon, then letters, digits, "_" or "-"
 * (for example `123456789:AAH…`). Telegram does not publish an exact length,
 * so this is only a hint shown to the admin, never a reason to refuse: the
 * server asks Telegram whether the token works.
 */
export function looksLikeBotToken(text: string): boolean {
  return /^\d{5,15}:[A-Za-z0-9_-]{20,}$/u.test(text.trim());
}
