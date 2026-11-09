/**
 * Pure voice-call policies (ADR 045, owner decisions V4/V5/V6). Persistence
 * and queueing come later; these functions only decide.
 */

/** Operator hours: SIP transfer is offered 09:00-18:00 tenant time. */
export const HANDOVER_WINDOW = { startMinute: 9 * 60, endMinute: 18 * 60 };
/** Outbound calls are allowed 09:00-19:00 tenant time. */
export const OUTBOUND_WINDOW = { startMinute: 9 * 60, endMinute: 19 * 60 };
export const RECORDING_RETENTION_DAYS = 90;
export const RECORDING_PLAYBACK_ROLES: readonly string[] = ['OWNER', 'ADMIN'];

export interface MinuteWindow {
  readonly startMinute: number;
  readonly endMinute: number;
}

/** Minutes since local midnight of `now` in an IANA time zone. */
export function tenantMinuteOfDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  return get('hour') * 60 + get('minute');
}

export function withinWindow(
  now: Date,
  timeZone: string,
  window: MinuteWindow,
): boolean {
  const minute = tenantMinuteOfDay(now, timeZone);
  return minute >= window.startMinute && minute < window.endMinute;
}

export type HandoverDecision =
  | { readonly kind: 'TRANSFER'; readonly toNumber: string }
  | {
      readonly kind: 'CALLBACK_REQUEST';
      readonly reason: 'AFTER_HOURS' | 'NO_OPERATOR_NUMBER' | 'TRANSFER_FAILED';
    };

export function decideHandover(input: {
  readonly now: Date;
  readonly timeZone: string;
  readonly operatorNumber?: string;
}): HandoverDecision {
  if (!input.operatorNumber) {
    return { kind: 'CALLBACK_REQUEST', reason: 'NO_OPERATOR_NUMBER' };
  }
  if (!withinWindow(input.now, input.timeZone, HANDOVER_WINDOW)) {
    return { kind: 'CALLBACK_REQUEST', reason: 'AFTER_HOURS' };
  }
  return { kind: 'TRANSFER', toNumber: input.operatorNumber };
}

export type OutboundRefusal =
  | 'NO_OPT_IN_CALLBACK'
  | 'CONTACT_OPTED_OUT'
  | 'OUTSIDE_CALL_WINDOW'
  | 'DAILY_CAP_REACHED';

export type OutboundDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: OutboundRefusal };

export function decideOutbound(input: {
  readonly now: Date;
  readonly timeZone: string;
  /** The contact asked for a call-back (opt-in lead callback request). */
  readonly hasCallbackOptIn: boolean;
  readonly optedOut?: boolean;
  readonly callsPlacedToday: number;
  readonly dailyCap: number;
}): OutboundDecision {
  if (input.optedOut) return { allowed: false, reason: 'CONTACT_OPTED_OUT' };
  if (!input.hasCallbackOptIn) {
    return { allowed: false, reason: 'NO_OPT_IN_CALLBACK' };
  }
  if (!withinWindow(input.now, input.timeZone, OUTBOUND_WINDOW)) {
    return { allowed: false, reason: 'OUTSIDE_CALL_WINDOW' };
  }
  if (input.callsPlacedToday >= input.dailyCap) {
    return { allowed: false, reason: 'DAILY_CAP_REACHED' };
  }
  return { allowed: true };
}

export function recordingRetainUntil(startedAt: Date): Date {
  return new Date(
    startedAt.getTime() + RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
}

export function canPlayRecording(role: string): boolean {
  return RECORDING_PLAYBACK_ROLES.includes(role);
}
