/**
 * A Messenger reply is allowed inside the 24 hours that follow the customer's
 * last message (error 1545041 "Messaging window closed" otherwise; Send API
 * page, read 2026-11-06). The `HUMAN_AGENT` tag (7 days, manual replies) is
 * NOT implemented: that page does not show the tag's field name or exact
 * string, so it stays unverified and nothing is sent with a tag. Code decides,
 * not the model (D4).
 */
export const FACEBOOK_WINDOW_MS = 24 * 60 * 60 * 1000;

export type FacebookWindowDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'no_customer_message' | 'window_closed';
    };

export function evaluateFacebookWindow(input: {
  readonly lastCustomerMessageAt: Date | undefined;
  readonly now: Date;
}): FacebookWindowDecision {
  const { lastCustomerMessageAt: last, now } = input;
  if (!last) return { allowed: false, reason: 'no_customer_message' };
  const age = now.getTime() - last.getTime();
  return age < 0 || age <= FACEBOOK_WINDOW_MS
    ? { allowed: true }
    : { allowed: false, reason: 'window_closed' };
}
