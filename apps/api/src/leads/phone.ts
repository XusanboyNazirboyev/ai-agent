/**
 * Extracts a phone number the customer typed. Conservative on purpose: the
 * message must be essentially a phone number (digits, +, spaces, dashes,
 * brackets, an optional short label), with 9 to 15 digits. Nothing is
 * invented or completed; an uncertain message yields undefined.
 */
export function extractPhone(text: string): string | undefined {
  const digits = text.replace(/\D/gu, '');
  if (digits.length < 9 || digits.length > 15) return undefined;
  // A short label ("my phone:") is fine; a sentence with a long number in it
  // is not. Letters must stay few and clearly outnumbered by digits.
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length > 24 || digits.length * 2 < letters.length)
    return undefined;
  const plus = /\+\s*\(?\d/u.test(text) ? '+' : '';
  return `${plus}${digits}`;
}
