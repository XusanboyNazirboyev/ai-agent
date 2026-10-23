import { normalizeForMatching } from '@agentcore/shared';
import type { LocalePack } from '../locales/locale-pack.js';

const EDGE = /^[\s!.?,;:]+|[\s!.?,;:]+$/gu;
const compact = (value: string): string =>
  normalizeForMatching(value).replace(EDGE, '');

/**
 * Is the WHOLE message an opt-out phrase ("/stop", "стоп", "to'xtat")? Exact
 * match after normalization, in any supported language: a sentence that
 * merely contains the word is not an opt-out. Used both before a model call
 * and at message intake, so a /stop sent while an operator owns the
 * conversation is recorded too.
 */
export function isOptOutMessage(
  text: string,
  packs: readonly Pick<LocalePack, 'optOutPhrases'>[],
): boolean {
  const spoken = compact(text);
  return (
    spoken.length > 0 &&
    packs.some((pack) =>
      pack.optOutPhrases.some((phrase) => compact(phrase) === spoken),
    )
  );
}
