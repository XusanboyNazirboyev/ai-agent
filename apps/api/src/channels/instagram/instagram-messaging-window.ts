/**
 * Instagram allows a reply only inside a window opened by the customer's last
 * message: 24 hours, or up to 7 days for a HUMAN-written reply under the
 * `HUMAN_AGENT` tag (docs/research/channel-rules.md; no other tags exist for
 * this channel). The bot never sends outside 24 hours; a human operator may
 * until 7 days. Code decides, not the model (D4).
 */
export const BOT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type WindowDecision =
  | { readonly allowed: true; readonly tag: 'none' | 'HUMAN_AGENT' }
  | {
      readonly allowed: false;
      readonly reason:
        'no_customer_message' | 'bot_window_closed' | 'human_window_closed';
    };

export function evaluateMessagingWindow(input: {
  readonly lastCustomerMessageAt: Date | undefined;
  readonly now: Date;
  readonly author: 'bot' | 'human';
}): WindowDecision {
  const { lastCustomerMessageAt: last, now, author } = input;
  if (!last) return { allowed: false, reason: 'no_customer_message' };
  const age = now.getTime() - last.getTime();
  if (age < 0 || age <= BOT_WINDOW_MS) return { allowed: true, tag: 'none' };
  if (author === 'bot') return { allowed: false, reason: 'bot_window_closed' };
  if (age <= HUMAN_AGENT_WINDOW_MS)
    return { allowed: true, tag: 'HUMAN_AGENT' };
  return { allowed: false, reason: 'human_window_closed' };
}
