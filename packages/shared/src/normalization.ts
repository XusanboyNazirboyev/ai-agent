const apostrophes = /[’‘ʻʼ＇`´]/gu;
const repeatedWhitespace = /\s+/gu;

/** Minimal, versioned-safe matching normalization. Transliteration is Phase 4. */
export function normalizeCatalogText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(apostrophes, "'")
    .toLowerCase()
    .trim()
    .replace(repeatedWhitespace, ' ');
}
