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

/**
 * What happens to digits that a machine heard (ADR 042). `typed` (default):
 * a phone number is taken only from text the customer typed; one in a
 * speech transcript waits until the customer writes it (the first stored
 * phone is never replaced, so a misheard one would stay). `accept`: the
 * transcript is used like typed text (the behaviour before this setting).
 */
export type SpeechDigitsPolicy = 'typed' | 'accept';

export function phoneFromCustomerText(
  text: string,
  options: {
    /** The text is, or contains, a speech-to-text transcript. */
    readonly fromSpeech: boolean;
    readonly speechDigits: SpeechDigitsPolicy;
  },
): string | undefined {
  // Fail safe: only an explicit `accept` lets speech digits through.
  if (options.fromSpeech && options.speechDigits !== 'accept') return undefined;
  return extractPhone(text);
}
