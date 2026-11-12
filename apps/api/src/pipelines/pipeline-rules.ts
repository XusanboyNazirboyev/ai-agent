import { z } from 'zod';

/** ISO 4217 codes an operator may use for an opportunity amount (ADR 057). */
export const CURRENCIES = [
  'UZS',
  'USD',
  'EUR',
  'RUB',
  'KZT',
  'KGS',
  'TJS',
  'TRY',
  'GBP',
  'CNY',
  'AED',
] as const;

export const MAX_PIPELINES = 10;
export const MAX_STAGES_PER_PIPELINE = 20;
export const MAX_LOST_REASON = 200;
export const MAX_SOURCE = 60;

const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A decimal string such as `1500` or `1500.50`; never a JS number. */
export function isAmount(value: unknown): value is string {
  return typeof value === 'string' && AMOUNT.test(value);
}

export function isCurrency(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (CURRENCIES as readonly string[]).includes(value)
  );
}

/** A real calendar date `YYYY-MM-DD` (no 2026-02-30, no month 13). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function fromDateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/** Amount and currency are set together or not at all. */
export function amountCurrencyPaired(
  amount: string | null | undefined,
  currency: string | null | undefined,
): boolean {
  return (amount == null) === (currency == null);
}

export type LostReasonViolation = 'REQUIRED' | 'NOT_ALLOWED';

/**
 * `lostReason` rules: setting LOST requires a reason; any other status
 * carries none.
 */
export function checkLostReason(
  status: string,
  lostReason: string | null | undefined,
): LostReasonViolation | undefined {
  if (status === 'LOST') return lostReason ? undefined : 'REQUIRED';
  return lostReason ? 'NOT_ALLOWED' : undefined;
}

/** A reorder must list exactly the active stages, each once. */
export function validateStageOrder(
  submitted: readonly string[],
  active: readonly string[],
): boolean {
  if (submitted.length !== active.length) return false;
  const wanted = new Set(active);
  const seen = new Set<string>();
  for (const id of submitted) {
    if (!wanted.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

export interface OpportunityPatch {
  ownerOperatorId?: string | null;
  amount?: string | null;
  currency?: string | null;
  source?: string | null;
  expectedCloseDate?: string | null;
  lostReason?: string | null;
}

const OpportunityBody = z
  .object({
    ownerOperatorId: z.string().uuid().nullable().optional(),
    amount: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    expectedCloseDate: z.string().nullable().optional(),
    lostReason: z.string().nullable().optional(),
  })
  .strict();

export type OpportunityParse =
  | { ok: true; patch: OpportunityPatch }
  | { ok: false; code: 'INVALID_BODY' | 'INVALID_VALUE' };

/**
 * Shape and value checks that need no database: field types, decimal-string
 * amount, listed currency, strict amount/currency pair, real date, trimmed
 * lengths. The owner and the lead status are checked against the database.
 */
export function parseOpportunityPatch(body: unknown): OpportunityParse {
  const parsed = OpportunityBody.safeParse(body);
  if (!parsed.success) return { ok: false, code: 'INVALID_BODY' };
  const input = parsed.data;
  const patch: OpportunityPatch = {};
  if (input.ownerOperatorId !== undefined)
    patch.ownerOperatorId = input.ownerOperatorId;
  if ('amount' in input !== 'currency' in input)
    return { ok: false, code: 'INVALID_VALUE' };
  if ('amount' in input) {
    const { amount, currency } = input;
    if (!amountCurrencyPaired(amount, currency))
      return { ok: false, code: 'INVALID_VALUE' };
    if (amount != null && (!isAmount(amount) || !isCurrency(currency)))
      return { ok: false, code: 'INVALID_VALUE' };
    patch.amount = amount ?? null;
    patch.currency = currency ?? null;
  }
  if (input.source !== undefined) {
    const source = input.source === null ? '' : input.source.trim();
    if (source.length > MAX_SOURCE) return { ok: false, code: 'INVALID_VALUE' };
    patch.source = source === '' ? null : source;
  }
  if (input.expectedCloseDate !== undefined) {
    if (
      input.expectedCloseDate !== null &&
      !isCalendarDate(input.expectedCloseDate)
    )
      return { ok: false, code: 'INVALID_VALUE' };
    patch.expectedCloseDate = input.expectedCloseDate;
  }
  if (input.lostReason !== undefined) {
    const reason = input.lostReason === null ? '' : input.lostReason.trim();
    if (reason.length > MAX_LOST_REASON)
      return { ok: false, code: 'INVALID_VALUE' };
    patch.lostReason = reason === '' ? null : reason;
  }
  return { ok: true, patch };
}
