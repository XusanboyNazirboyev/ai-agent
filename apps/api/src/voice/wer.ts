/**
 * Word error rate for the Uzbek STT check (ADR 045 slice 3, step 6). Pure
 * functions; the runner is `scripts/voice-wer.ts`.
 *
 * Normalisation (docs/voice/wer-recording-script-uz.md): case, punctuation
 * and the apostrophe variants used for o‘ / g‘ and the tutuq belgisi are
 * folded, so "to‘lasa", "to'lasa" and "toʻlasa" are one word. Numbers are
 * compared as written; no number normaliser yet.
 */

/** U+2018, U+2019, U+0027, U+0060, U+02BB, U+02BC → U+02BB. */
const APOSTROPHES = /[‘’'`ʻʼ]/gu;
const CANONICAL_APOSTROPHE = 'ʻ';

export function normalizeForWer(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(APOSTROPHES, CANONICAL_APOSTROPHE)
      .split(/[^\p{L}\p{N}ʻ]+/u)
      // An apostrophe belongs to a word only inside it (o‘, g‘, ta'lim); at
      // either end it is a quote mark.
      .map((word) => word.replace(/^ʻ+|ʻ+$/gu, ''))
      .filter((word) => word.length > 0)
  );
}

export interface WordErrors {
  readonly referenceWords: number;
  readonly substitutions: number;
  readonly deletions: number;
  readonly insertions: number;
}

/** Minimum-edit alignment of hypothesis words against reference words. */
export function wordErrors(reference: string, hypothesis: string): WordErrors {
  const ref = normalizeForWer(reference);
  const hyp = normalizeForWer(hypothesis);
  type Cell = { cost: number; s: number; d: number; i: number };
  let previous: Cell[] = hyp.map((_, j) => ({
    cost: j + 1,
    s: 0,
    d: 0,
    i: j + 1,
  }));
  previous.unshift({ cost: 0, s: 0, d: 0, i: 0 });
  for (let r = 1; r <= ref.length; r++) {
    const row: Cell[] = [{ cost: r, s: 0, d: r, i: 0 }];
    for (let h = 1; h <= hyp.length; h++) {
      const diagonal = previous[h - 1]!;
      const same = ref[r - 1] === hyp[h - 1];
      const options: Cell[] = [
        {
          cost: diagonal.cost + (same ? 0 : 1),
          s: diagonal.s + (same ? 0 : 1),
          d: diagonal.d,
          i: diagonal.i,
        },
        { ...previous[h]!, cost: previous[h]!.cost + 1, d: previous[h]!.d + 1 },
        { ...row[h - 1]!, cost: row[h - 1]!.cost + 1, i: row[h - 1]!.i + 1 },
      ];
      row.push(
        options.reduce((best, next) => (next.cost < best.cost ? next : best)),
      );
    }
    previous = row;
  }
  const last = previous[hyp.length]!;
  return {
    referenceWords: ref.length,
    substitutions: last.s,
    deletions: last.d,
    insertions: last.i,
  };
}

export function errorCount(errors: WordErrors): number {
  return errors.substitutions + errors.deletions + errors.insertions;
}

export function werOf(errors: WordErrors): number {
  return errors.referenceWords === 0
    ? 0
    : errorCount(errors) / errors.referenceWords;
}

/** Corpus WER: total errors over total reference words. */
export function summarizeWer(lines: readonly WordErrors[]): WordErrors & {
  readonly wer: number;
} {
  const total = lines.reduce(
    (sum, line) => ({
      referenceWords: sum.referenceWords + line.referenceWords,
      substitutions: sum.substitutions + line.substitutions,
      deletions: sum.deletions + line.deletions,
      insertions: sum.insertions + line.insertions,
    }),
    { referenceWords: 0, substitutions: 0, deletions: 0, insertions: 0 },
  );
  return { ...total, wer: werOf(total) };
}

export interface WerReference {
  readonly id: string;
  readonly text: string;
  readonly noisy: boolean;
}

/** Reads the `| 01 | line | what |` rows of the recording script. */
export function parseWerScript(markdown: string): WerReference[] {
  const references: WerReference[] = [];
  for (const line of markdown.split('\n')) {
    const match = /^\|\s*(\d{2})\s*\|\s*(.+?)\s*\|[^|]*\|\s*$/u.exec(line);
    if (!match) continue;
    const raw = match[2]!;
    const noisy = /\(noise\)\s*$/u.test(raw);
    references.push({
      id: match[1]!,
      text: raw.replace(/\s*\(noise\)\s*$/u, ''),
      noisy,
    });
  }
  return references;
}

export interface ReferenceMatch {
  readonly recordingIndex: number;
  readonly referenceId: string;
  readonly wer: number;
}

/**
 * When the recordings are not named by line number: pairs each transcript
 * with the closest reference, best pairs first, each reference used once.
 * The result must be confirmed by the speaker before WER is reported.
 */
export function matchToReferences(
  transcripts: readonly string[],
  references: readonly WerReference[],
): ReferenceMatch[] {
  const pairs: ReferenceMatch[] = [];
  transcripts.forEach((text, recordingIndex) => {
    for (const reference of references)
      pairs.push({
        recordingIndex,
        referenceId: reference.id,
        wer: werOf(wordErrors(reference.text, text)),
      });
  });
  pairs.sort((a, b) => a.wer - b.wer);
  const usedRecordings = new Set<number>();
  const usedReferences = new Set<string>();
  const chosen: ReferenceMatch[] = [];
  for (const pair of pairs) {
    if (
      usedRecordings.has(pair.recordingIndex) ||
      usedReferences.has(pair.referenceId)
    )
      continue;
    usedRecordings.add(pair.recordingIndex);
    usedReferences.add(pair.referenceId);
    chosen.push(pair);
  }
  return chosen.sort((a, b) => a.recordingIndex - b.recordingIndex);
}
