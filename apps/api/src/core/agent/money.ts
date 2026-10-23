/**
 * Exact comparison of non-negative decimal strings (no floating point):
 * is `amount` at least `minimum`? Both are `digits[.digits]`.
 */
export function decimalAtLeast(amount: string, minimum: string): boolean {
  const [ai, af = ''] = amount.split('.');
  const [mi, mf = ''] = minimum.split('.');
  const scale = Math.max(af.length, mf.length);
  const a = BigInt(ai + af.padEnd(scale, '0'));
  const m = BigInt(mi + mf.padEnd(scale, '0'));
  return a >= m;
}
