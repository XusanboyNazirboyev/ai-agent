/** Fixed platform time zone of the overview's calendar months (ADR 047, 2026-11-19). */
export const OVERVIEW_TIME_ZONE = 'Asia/Tashkent';

/** "YYYY-MM" of an instant in the given time zone. */
export function monthKeyOf(
  date: Date,
  timeZone: string = OVERVIEW_TIME_ZONE,
): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')!.value;
  const month = parts.find((part) => part.type === 'month')!.value;
  return `${year}-${month}`;
}

/** `count` calendar months ending with the month of `now`, oldest first. */
export function monthKeys(
  now: Date,
  count: number,
  timeZone: string = OVERVIEW_TIME_ZONE,
): string[] {
  const [year, month] = monthKeyOf(now, timeZone).split('-').map(Number) as [
    number,
    number,
  ];
  const keys: string[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const index = year * 12 + (month - 1) - back;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    keys.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`);
  }
  return keys;
}

/** Minor-unit digits of a currency (UZS, USD: 2; JPY: 0). */
export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** Integer minor units to a decimal string, by code ("150000.50"). */
export function minorToDecimal(minor: bigint, currency: string): string {
  const digits = currencyDigits(currency);
  const negative = minor < 0n;
  const text = (negative ? -minor : minor).toString().padStart(digits + 1, '0');
  const whole = text.slice(0, text.length - digits);
  const fraction = text.slice(text.length - digits);
  return `${negative ? '-' : ''}${whole}${digits > 0 ? `.${fraction}` : ''}`;
}

/** Price per `periodDays` normalised to 30 days, rounded to a minor unit. */
export function monthlyEquivalentMinor(
  priceMinor: bigint,
  periodDays: number,
): bigint {
  if (periodDays <= 0) return 0n;
  const days = BigInt(periodDays);
  return (priceMinor * 30n + days / 2n) / days;
}
