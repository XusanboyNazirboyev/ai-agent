/**
 * When may the bot send a follow-up to a silent customer (spec §8, Phase 6)?
 * Pure and conservative: every condition must hold, and any doubt means no
 * message. Time zones, consent and opt-outs are inputs, not assumptions.
 */
export interface FollowUpPolicy {
  /** Hours of silence after the bot's last message before the first follow-up. */
  readonly afterHours: number;
  /** Maximum follow-ups per conversation. */
  readonly maxPerConversation: number;
  /** Local quiet hours [start, end): no follow-up is sent inside them. */
  readonly quietStartHour: number;
  readonly quietEndHour: number;
}

export const DEFAULT_FOLLOW_UP_POLICY: FollowUpPolicy = {
  afterHours: 24,
  maxPerConversation: 1,
  quietStartHour: 21,
  quietEndHour: 9,
};

export interface FollowUpCandidate {
  readonly state:
    'BOT_ACTIVE' | 'WAITING_OPERATOR' | 'OPERATOR_ACTIVE' | 'CLOSED';
  /** The newest message of the conversation. */
  readonly lastMessage: {
    readonly direction: 'INBOUND' | 'OUTBOUND';
    readonly author: 'CUSTOMER' | 'BOT' | 'OPERATOR' | 'SYSTEM';
    readonly delivered: boolean;
    readonly at: Date;
  };
  readonly contact: {
    readonly marketingOptOut: boolean;
    readonly consent: 'UNKNOWN' | 'GRANTED' | 'REVOKED';
    readonly deleted: boolean;
  };
  readonly followUpsSent: number;
  /** The customer saw something concrete (an offer) or is a qualified lead. */
  readonly hasValue: boolean;
  readonly timeZone: string;
}

export type FollowUpDecision =
  | { readonly send: true }
  | {
      readonly send: false;
      readonly reason:
        | 'NOT_BOT_ACTIVE'
        | 'CUSTOMER_LAST'
        | 'NOT_DELIVERED'
        | 'OPTED_OUT'
        | 'NO_VALUE'
        | 'LIMIT_REACHED'
        | 'TOO_EARLY'
        | 'QUIET_HOURS';
      /** Quiet hours and earliness are retried later; the rest are final. */
      readonly retry: boolean;
    };

/** Hour of day (0-23) at `now` in an IANA time zone. */
export function localHour(now: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone,
  })
    .formatToParts(now)
    .find((part) => part.type === 'hour')?.value;
  return Number(hour);
}

export function inQuietHours(
  now: Date,
  timeZone: string,
  policy: Pick<FollowUpPolicy, 'quietStartHour' | 'quietEndHour'>,
): boolean {
  const hour = localHour(now, timeZone);
  const { quietStartHour: start, quietEndHour: end } = policy;
  return start <= end
    ? hour >= start && hour < end
    : hour >= start || hour < end; // wraps midnight (21 to 9)
}

export function decideFollowUp(
  candidate: FollowUpCandidate,
  now: Date,
  policy: FollowUpPolicy = DEFAULT_FOLLOW_UP_POLICY,
): FollowUpDecision {
  const no = (
    reason: Extract<FollowUpDecision, { send: false }>['reason'],
    retry = false,
  ): FollowUpDecision => ({ send: false, reason, retry });
  if (candidate.state !== 'BOT_ACTIVE') return no('NOT_BOT_ACTIVE');
  if (
    candidate.contact.marketingOptOut ||
    candidate.contact.consent === 'REVOKED' ||
    candidate.contact.deleted
  )
    return no('OPTED_OUT');
  const last = candidate.lastMessage;
  if (last.direction !== 'OUTBOUND' || last.author !== 'BOT')
    return no('CUSTOMER_LAST');
  if (!last.delivered) return no('NOT_DELIVERED');
  if (!candidate.hasValue) return no('NO_VALUE');
  if (candidate.followUpsSent >= policy.maxPerConversation)
    return no('LIMIT_REACHED');
  // Each further follow-up waits twice as long as the one before.
  const waitMs = policy.afterHours * 3_600_000 * 2 ** candidate.followUpsSent;
  if (now.getTime() - last.at.getTime() < waitMs) return no('TOO_EARLY', true);
  if (inQuietHours(now, candidate.timeZone, policy))
    return no('QUIET_HOURS', true);
  return { send: true };
}
