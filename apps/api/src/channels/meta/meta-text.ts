/**
 * Splits a reply into parts that each fit a byte limit (Uzbek Cyrillic and
 * accented letters take 2+ bytes each). Split on whitespace, never inside a
 * character. Shared by the Meta channels: Instagram documents 1,000 BYTES; the
 * Messenger send page states no limit, so it uses the same conservative cap.
 */
export const META_TEXT_MAX_BYTES = 1_000;

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

export function splitMetaText(
  text: string,
  maxBytes: number = META_TEXT_MAX_BYTES,
): string[] {
  const clean = text.trim();
  if (clean === '') return [];
  if (bytes(clean) <= maxBytes) return [clean];
  const parts: string[] = [];
  let current = '';
  const push = (): void => {
    if (current !== '') parts.push(current);
    current = '';
  };
  for (const word of clean.split(/\s+/)) {
    let rest = word;
    // A single word longer than a part: cut it by whole code points.
    while (bytes(rest) > maxBytes) {
      push();
      let piece = '';
      for (const ch of rest) {
        if (bytes(piece + ch) > maxBytes) break;
        piece += ch;
      }
      parts.push(piece);
      rest = rest.slice(piece.length);
    }
    const candidate = current === '' ? rest : `${current} ${rest}`;
    if (bytes(candidate) <= maxBytes) current = candidate;
    else {
      push();
      current = rest;
    }
  }
  push();
  return parts;
}
