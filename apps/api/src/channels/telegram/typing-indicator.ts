/**
 * Shows "typing…" while a reply is being prepared. Telegram keeps the status
 * for 5 seconds or less and clears it when the bot's message arrives
 * (Bot API sendChatAction, read 2026-11-04), so it is repeated every
 * `everyMs` until `stop` or `maxMs`. Best effort: a failed send changes
 * nothing about the reply.
 *
 * Why: a reply took 20-25 s on staging; the customer wrote again meanwhile,
 * and each newer message superseded the reply that was nearly ready.
 */
export function startTyping(
  send: () => Promise<unknown>,
  options: { everyMs?: number; maxMs?: number } = {},
): () => void {
  const everyMs = options.everyMs ?? 4_000;
  const maxMs = options.maxMs ?? 90_000;
  const tick = (): void => {
    send().catch(() => undefined);
  };
  tick();
  const timer = setInterval(tick, everyMs);
  const limit = setTimeout(() => clearInterval(timer), maxMs);
  timer.unref?.();
  limit.unref?.();
  return () => {
    clearInterval(timer);
    clearTimeout(limit);
  };
}
