import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Click Shop API rules (ADR 082). Facts: docs.click.uz/shop-api/requests and
 * /shop-api/errors, read 2026-11-19. Pure functions; no I/O.
 */

export const CLICK_PAY_URL = 'https://my.click.uz/services/pay/';

/** Merchant answer codes (docs.click.uz/shop-api/errors). */
export const CLICK_ERROR = {
  OK: 0,
  SIGN_CHECK_FAILED: -1,
  INCORRECT_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4,
  USER_NOT_FOUND: -5,
  TRANSACTION_NOT_FOUND: -6,
  UPDATE_FAILED: -7,
  BAD_REQUEST: -8,
  CANCELLED: -9,
} as const;
export type ClickErrorCode = (typeof CLICK_ERROR)[keyof typeof CLICK_ERROR];

export const CLICK_ERROR_NOTE: Record<ClickErrorCode, string> = {
  [CLICK_ERROR.OK]: 'Success',
  [CLICK_ERROR.SIGN_CHECK_FAILED]: 'SIGN CHECK FAILED!',
  [CLICK_ERROR.INCORRECT_AMOUNT]: 'Incorrect parameter amount',
  [CLICK_ERROR.ACTION_NOT_FOUND]: 'Action not found',
  [CLICK_ERROR.ALREADY_PAID]: 'Already paid',
  [CLICK_ERROR.USER_NOT_FOUND]: 'User does not exist',
  [CLICK_ERROR.TRANSACTION_NOT_FOUND]: 'Transaction does not exist',
  [CLICK_ERROR.UPDATE_FAILED]: 'Failed to update user',
  [CLICK_ERROR.BAD_REQUEST]: 'Error in request from click',
  [CLICK_ERROR.CANCELLED]: 'Transaction cancelled',
};

export type ClickAction = 0 | 1;

/** The string fields of a Prepare/Complete request, exactly as received. */
export interface ClickRequest {
  readonly clickTransId: string;
  readonly serviceId: string;
  readonly clickPaydocId: string;
  readonly merchantTransId: string;
  /** Present on Complete only. */
  readonly merchantPrepareId: string | undefined;
  readonly amount: string;
  readonly action: string;
  readonly error: string;
  readonly signTime: string;
  readonly signString: string;
}

const DIGITS = /^\d{1,18}$/u;
const SIGNED_DIGITS = /^-?\d{1,9}$/u;

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads the form body. Undefined when a required field is missing or
 * malformed (the caller answers -8). Customer-controlled text: only typed
 * string fields are read.
 */
export function parseClickRequest(
  body: unknown,
  complete: boolean,
): ClickRequest | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const source = body as Record<string, unknown>;
  const clickTransId = text(source.click_trans_id);
  const serviceId = text(source.service_id);
  const clickPaydocId = text(source.click_paydoc_id);
  const merchantTransId = text(source.merchant_trans_id);
  const merchantPrepareId = text(source.merchant_prepare_id);
  const amount = text(source.amount);
  const action = text(source.action);
  const error = text(source.error);
  const signTime = text(source.sign_time);
  const signString = text(source.sign_string);
  if (
    clickTransId === undefined ||
    !DIGITS.test(clickTransId) ||
    serviceId === undefined ||
    !DIGITS.test(serviceId) ||
    clickPaydocId === undefined ||
    !DIGITS.test(clickPaydocId) ||
    merchantTransId === undefined ||
    merchantTransId.length === 0 ||
    merchantTransId.length > 200 ||
    amount === undefined ||
    amount.length === 0 ||
    amount.length > 40 ||
    action === undefined ||
    !SIGNED_DIGITS.test(action) ||
    error === undefined ||
    !SIGNED_DIGITS.test(error) ||
    signTime === undefined ||
    signTime.length === 0 ||
    signTime.length > 64 ||
    signString === undefined ||
    signString.length === 0 ||
    signString.length > 128
  )
    return undefined;
  if (complete && (merchantPrepareId === undefined || merchantPrepareId === ''))
    return undefined;
  return {
    clickTransId,
    serviceId,
    clickPaydocId,
    merchantTransId,
    merchantPrepareId: complete ? merchantPrepareId : undefined,
    amount,
    action,
    error,
    signTime,
    signString,
  };
}

/**
 * md5 of the fields in the documented order. Prepare:
 * click_trans_id + service_id + SECRET_KEY + merchant_trans_id + amount +
 * action + sign_time. Complete adds merchant_prepare_id after
 * merchant_trans_id. Never log the result or the secret.
 */
export function clickSignature(
  request: ClickRequest,
  secretKey: string,
  complete: boolean,
): string {
  const parts = [
    request.clickTransId,
    request.serviceId,
    secretKey,
    request.merchantTransId,
    ...(complete ? [request.merchantPrepareId ?? ''] : []),
    request.amount,
    request.action,
    request.signTime,
  ];
  return createHash('md5').update(parts.join('')).digest('hex');
}

/** Constant-time comparison of the presented signature with the expected one. */
export function signatureMatches(
  request: ClickRequest,
  secretKey: string,
  complete: boolean,
): boolean {
  const expected = Buffer.from(clickSignature(request, secretKey, complete));
  const presented = Buffer.from(request.signString.toLowerCase());
  return (
    expected.length === presented.length && timingSafeEqual(expected, presented)
  );
}

/** Minor units (tiyin) of a UZS amount as "N.NN"; exact, no floating point. */
export function formatClickAmount(amountMinor: bigint): string {
  if (amountMinor < 0n) throw new RangeError('amount must not be negative');
  const whole = amountMinor / 100n;
  const cents = (amountMinor % 100n).toString().padStart(2, '0');
  return `${whole}.${cents}`;
}

/**
 * Minor units of the amount Click sends ("50000", "50000.5", "50000.00").
 * Undefined for anything else (exponent, sign, more than 2 decimals that are
 * not zeros).
 */
export function parseClickAmount(raw: string): bigint | undefined {
  const match = /^(\d{1,15})(?:\.(\d{1,6}))?$/u.exec(raw.trim());
  if (!match) return undefined;
  const fraction = match[2] ?? '';
  if (fraction.length > 2 && /[^0]/u.test(fraction.slice(2))) return undefined;
  const cents = fraction.slice(0, 2).padEnd(2, '0');
  return BigInt(match[1] ?? '0') * 100n + BigInt(cents);
}

export interface ClickPayLink {
  readonly serviceId: string;
  readonly merchantId: string;
  readonly merchantUserId?: string | undefined;
  readonly amountMinor: bigint;
  readonly paymentId: string;
  readonly returnUrl: string;
}

/** The documented pay link (docs.click.uz/click-button). */
export function buildClickPayLink(link: ClickPayLink): string {
  const query: [string, string][] = [
    ['service_id', link.serviceId],
    ['merchant_id', link.merchantId],
    ...(link.merchantUserId
      ? ([['merchant_user_id', link.merchantUserId]] as [string, string][])
      : []),
    ['amount', formatClickAmount(link.amountMinor)],
    ['transaction_param', link.paymentId],
    ['return_url', link.returnUrl],
  ];
  return `${CLICK_PAY_URL}?${query
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Same rule as the console's extension: counted from the end, never in the past. */
export function extendedPeriodEnd(
  currentEnd: Date,
  days: number,
  now: Date,
): Date {
  const fromEnd = addDays(currentEnd, days);
  return fromEnd > now ? fromEnd : addDays(now, days);
}

export interface ClickAnswer {
  readonly click_trans_id: number | string;
  readonly merchant_trans_id: string;
  readonly merchant_prepare_id?: number;
  readonly merchant_confirm_id?: number;
  readonly error: number;
  readonly error_note: string;
}
