/**
 * Extracts a phone number the customer typed. Conservative on purpose: the
 * message must be essentially a phone number (digits, +, spaces, dashes,
 * brackets, an optional short label), with 9 to 15 digits. Nothing is
 * invented or completed; an uncertain message yields undefined.
 */
export function extractPhone(text: string): string | undefined {
  const digits = text.replace(/\D/gu, '');
  if (digits.length < 9 || digits.length > 15) return undefined;
  // Letters beyond a short label mean this is a sentence, not a number.
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length > 12) return undefined;
  const plus = /^\s*(?:[^\d+]{0,12})\+/u.test(text) ? '+' : '';
  return `${plus}${digits}`;
}
