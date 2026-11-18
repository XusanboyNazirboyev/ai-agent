import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  chunkText,
  DEFAULT_CHUNK_OPTIONS,
} from '../src/core/knowledge/chunking.js';
import { createEmbeddingProvider } from '../src/knowledge/embedding.factory.js';

/**
 * Chunk-boundary check for knowledge answers (ChatLab research item 3).
 *
 *   LIVE_KNOWLEDGE_EVAL=1 KNOWLEDGE_EMBEDDINGS=gemini \
 *   KNOWLEDGE_EMBEDDING_MODEL=gemini-embedding-2 \
 *   pnpm --filter @agentcore/api exec tsx scripts/knowledge-chunk-eval.ts
 *
 * FICTIONAL text only (eval/knowledge/multi-chunk.json). The documents are
 * chunked with the production chunker, chunks and queries are embedded in one
 * request, and similarity is computed in process (no database, no customer
 * data). For each query it reports whether the sentence that answers it is in
 * the top passage, in the four passages the agent retrieves today
 * (`KnowledgeRetriever` limit), and in those four plus the neighbouring
 * chunks of the same document, with the characters each variant adds.
 */

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

interface Corpus {
  documents: Array<{ id: string; lang: string; text: string }>;
  queries: Array<{ lang: string; text: string; doc: string; answer: string }>;
}

interface Chunk {
  readonly doc: string;
  readonly ordinal: number;
  readonly text: string;
}

const TOP_K = 4;

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

const fold = (text: string): string =>
  text
    .replace(/[‘’ʻʼ`]/gu, "'")
    .replace(/\s+/gu, ' ')
    .toLowerCase();

const contains = (chunks: readonly Chunk[], answer: string): boolean =>
  chunks.some((chunk) => fold(chunk.text).includes(fold(answer)));

const chars = (chunks: readonly Chunk[]): number =>
  chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);

/** The hits plus the chunk before and after each, same document, no repeats. */
function withNeighbours(
  hits: readonly Chunk[],
  all: readonly Chunk[],
): Chunk[] {
  const key = (chunk: Chunk): string => `${chunk.doc}#${chunk.ordinal}`;
  const wanted = new Set<string>();
  for (const hit of hits)
    for (const ordinal of [hit.ordinal - 1, hit.ordinal, hit.ordinal + 1])
      wanted.add(`${hit.doc}#${ordinal}`);
  return all.filter((chunk) => wanted.has(key(chunk)));
}

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
      resolve(process.cwd(), '../../eval/knowledge/multi-chunk.json'),
      'utf8',
    ),
  ) as Corpus;
  const chunks: Chunk[] = corpus.documents.flatMap((doc) =>
    chunkText(doc.text, DEFAULT_CHUNK_OPTIONS).map((text, ordinal) => ({
      doc: doc.id,
      ordinal,
      text,
    })),
  );
  for (const query of corpus.queries) {
    const own = chunks.filter((chunk) => chunk.doc === query.doc);
    if (!contains(own, query.answer))
      throw new Error(`Answer not in its document: ${query.answer}`);
  }
  const texts = [
    ...chunks.map((chunk) => chunk.text),
    ...corpus.queries.map((query) => query.text),
  ];
  if (texts.length > 80)
    throw new Error('Corpus too large for the bounded check');
  const started = Date.now();
  const { vectors, inputTokens } = await embedder.embed(texts);
  const chunkVectors = vectors.slice(0, chunks.length);
  const queryVectors = vectors.slice(chunks.length);

  const rows: string[] = [];
  const totals = { top1: 0, top4: 0, top1Plus: 0, top4Plus: 0 };
  const size = { top4: 0, top1Plus: 0, top4Plus: 0 };
  corpus.queries.forEach((query, qi) => {
    const ranked = chunks
      .map((chunk, ci) => ({
        chunk,
        score: cosine(queryVectors[qi], chunkVectors[ci]),
      }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.chunk);
    const top1 = ranked.slice(0, 1);
    const top4 = ranked.slice(0, TOP_K);
    const top1Plus = withNeighbours(top1, chunks);
    const top4Plus = withNeighbours(top4, chunks);
    const hit = {
      top1: contains(top1, query.answer),
      top4: contains(top4, query.answer),
      top1Plus: contains(top1Plus, query.answer),
      top4Plus: contains(top4Plus, query.answer),
    };
    for (const key of Object.keys(totals) as Array<keyof typeof totals>)
      if (hit[key]) totals[key] += 1;
    size.top4 += chars(top4);
    size.top1Plus += chars(top1Plus);
    size.top4Plus += chars(top4Plus);
    const mark = (ok: boolean): string => (ok ? 'yes' : 'no');
    rows.push(
      `| ${query.lang} | ${query.text} | ${mark(hit.top1)} | ${mark(hit.top4)} | ${mark(hit.top1Plus)} | ${mark(hit.top4Plus)} |`,
    );
  });
  const n = corpus.queries.length;
  const avg = (value: number): number => Math.round(value / n);
  const lines = [
    '# Knowledge chunk-boundary check (fictional text)',
    '',
    `Provider ${embedder.providerId}, model ${embedder.model}, ${new Date().toISOString()}. ${chunks.length} chunks from ${corpus.documents.length} documents (chunker ${DEFAULT_CHUNK_OPTIONS.maxChars}/${DEFAULT_CHUNK_OPTIONS.overlapChars}), ${n} queries, ${inputTokens ?? 'unreported'} input tokens, ${Date.now() - started} ms.`,
    '',
    '| Lang | Query | Answer in top 1 | In top 4 (today) | Top 1 + neighbours | Top 4 + neighbours |',
    '|---|---|---|---|---|---|',
    ...rows,
    `| | **Total** | ${totals.top1}/${n} | ${totals.top4}/${n} | ${totals.top1Plus}/${n} | ${totals.top4Plus}/${n} |`,
    '',
    `Average characters: top 4 ${avg(size.top4)}, top 1 + neighbours ${avg(size.top1Plus)}, top 4 + neighbours ${avg(size.top4Plus)}.`,
    '',
    'Shows: whether the answering sentence reaches the retrieved passages for short, paraphrased questions over three fictional multi-paragraph policies. Does not show: real tenant documents, the pack minimum score, answer quality, Cyrillic Uzbek, or other models; the Uzbek and Russian wording is unreviewed.',
  ];
  const report = `${lines.join('\n')}\n`;
  const dir = resolve(process.cwd(), '../../eval/reports');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(
      dir,
      `knowledge-chunks-${new Date().toISOString().replace(/[:.]/gu, '-')}.md`,
    ),
    report,
  );
  process.stdout.write(report);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
