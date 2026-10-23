/**
 * Splits knowledge text into passages for embedding. Paragraphs are kept
 * together when they fit; longer ones are cut at sentence ends, then at
 * spaces, and consecutive chunks of one paragraph overlap slightly so a
 * statement cut at a boundary stays retrievable. Pure and deterministic.
 */
export interface ChunkOptions {
  readonly maxChars: number;
  readonly overlapChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxChars: 900,
  overlapChars: 120,
};

export function chunkText(
  text: string,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): string[] {
  const { maxChars, overlapChars } = options;
  if (maxChars < 100 || overlapChars < 0 || overlapChars >= maxChars / 2)
    throw new RangeError('Invalid chunk options');
  const paragraphs = text
    .replace(/\r\n?/gu, '\n')
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);
  const chunks: string[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer.length > 0) chunks.push(buffer);
    buffer = '';
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      chunks.push(...splitLong(paragraph, maxChars, overlapChars));
    } else if (buffer.length + paragraph.length + 1 <= maxChars) {
      buffer = buffer ? `${buffer} ${paragraph}` : paragraph;
    } else {
      flush();
      buffer = paragraph;
    }
  }
  flush();
  return chunks;
}

function splitLong(
  paragraph: string,
  maxChars: number,
  overlap: number,
): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < paragraph.length) {
    let end = Math.min(paragraph.length, start + maxChars);
    if (end < paragraph.length) {
      const window = paragraph.slice(start, end);
      const sentence = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
      );
      const space = window.lastIndexOf(' ');
      const cut =
        sentence > maxChars * 0.4
          ? sentence + 1
          : space > maxChars * 0.4
            ? space
            : -1;
      if (cut > 0) end = start + cut;
    }
    parts.push(paragraph.slice(start, end).trim());
    if (end >= paragraph.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return parts.filter((part) => part.length > 0);
}
