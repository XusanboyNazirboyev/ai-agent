import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createEmbeddingProvider } from '../src/knowledge/embedding.factory.js';

/**
 * LIVE_KNOWLEDGE_EVAL=1 pnpm --filter @agentcore/api knowledge:eval
 *
 * Opt-in cross-lingual retrieval check on FICTIONAL text only
 * (eval/knowledge/cross-lingual.json). One embedding request with all
 * documents and queries (at most MAX 80 texts, ~20 KB); similarity is
 * computed in process, so no database or customer data is involved. The
 * report names provider and model, and states what it does and does not show.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

interface Corpus {
  documents: Array<{ id: string; texts: Record<string, string> }>;
  queries: Array<{ lang: string; text: string; expect: string }>;
}

const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

async function main(): Promise<void> {
  if (process.env.LIVE_KNOWLEDGE_EVAL !== '1')
    throw new Error(
      'Opt-in: set LIVE_KNOWLEDGE_EVAL=1 (sends fictional text to the embedding provider)',
    );
  const embedder = createEmbeddingProvider({
    KNOWLEDGE_EMBEDDINGS: (process.env.KNOWLEDGE_EMBEDDINGS ?? 'off') as
      'off' | 'gemini' | 'openai-compatible' | 'hashing',
    KNOWLEDGE_EMBEDDING_MODEL: process.env.KNOWLEDGE_EMBEDDING_MODEL,
    KNOWLEDGE_EMBEDDING_BASE_URL: process.env.KNOWLEDGE_EMBEDDING_BASE_URL,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
  });
  if (!embedder)
    throw new Error(
      'Set KNOWLEDGE_EMBEDDINGS and KNOWLEDGE_EMBEDDING_MODEL first',
    );
  const corpus = JSON.parse(
    readFileSync(
      resolve(process.cwd(), '../../eval/knowledge/cross-lingual.json'),
      'utf8',
    ),
  ) as Corpus;
  const langs = ['en', 'ru', 'uz'] as const;
  const docTexts = corpus.documents.flatMap((d) =>
    langs.map((l) => ({ id: d.id, lang: l, text: d.texts[l] })),
  );
  const texts = [
    ...docTexts.map((d) => d.text),
    ...corpus.queries.map((q) => q.text),
  ];
  if (texts.length > 80)
    throw new Error('Corpus too large for the bounded check');
  const started = Date.now();
  const { vectors, inputTokens } = await embedder.embed(texts);
  const docVectors = vectors.slice(0, docTexts.length);
  const queryVectors = vectors.slice(docTexts.length);
  const matrix: Record<string, { hits: number; total: number }> = {};
  corpus.queries.forEach((query, qi) => {
    for (const indexLang of langs) {
      const candidates = docTexts
        .map((doc, di) => ({
          doc,
          score: cosine(queryVectors[qi], docVectors[di]),
        }))
        .filter((c) => c.doc.lang === indexLang)
        .sort((a, b) => b.score - a.score);
      const cell = (matrix[`${query.lang} -> ${indexLang}`] ??= {
        hits: 0,
        total: 0,
      });
      cell.total += 1;
      if (candidates[0]?.doc.id === query.expect) cell.hits += 1;
    }
  });
  const lines = [
    '# Cross-lingual retrieval check (live, fictional text)',
    '',
    `Provider ${embedder.providerId}, model ${embedder.model}, ${new Date().toISOString()}. ${texts.length} texts in one request, ${inputTokens ?? 'unreported'} input tokens, ${Date.now() - started} ms.`,
    '',
    '| Query language -> index language | Top-1 correct |',
    '|---|---|',
    ...Object.entries(matrix).map(
      ([k, v]) => `| ${k} | ${v.hits}/${v.total} |`,
    ),
    '',
    'Shows: whether this model ranks the right fictional policy first across Uzbek (Latin), Russian and English in a 6-document index. Does not show: accuracy on real documents, large indexes, typos, Cyrillic Uzbek, or other models; the Uzbek and Russian wording is unreviewed.',
  ];
  const dir = resolve(process.cwd(), '../../eval/reports');
  mkdirSync(dir, { recursive: true });
  const report = `${lines.join('\n')}\n`;
  writeFileSync(
    resolve(
      dir,
      `knowledge-${new Date().toISOString().replace(/[:.]/gu, '-')}.md`,
    ),
    report,
  );
  process.stdout.write(report);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Failed'}\n`,
  );
  process.exitCode = 1;
});
