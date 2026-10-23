import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Golden rule (AGENTS.md §0.8, §13): `src/core/**` holds the generic engine
 * only. It must not import Domain Packs, Locale Packs, specific connectors
 * or vendor SDKs, and must not contain vertical- or CRM-specific words.
 */
const CORE = join(process.cwd(), 'src/core');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? files(path)
      : path.endsWith('.ts')
        ? [path]
        : [];
  });
}

const FORBIDDEN_IMPORTS = [
  /from '[^']*\/packs\//u,
  /from '[^']*\/locales\/locale-packs/u,
  /from '[^']*\/connectors\/(?:mock|generic-rest|registry|sync)\//u,
  /from '[^']*\/llm\/anthropic\//u,
  /from '@anthropic-ai\//u,
  /from 'openai'/u,
  /from '@google\/genai'/u,
];

const DOMAIN_WORDS =
  /\b(?:ielts|course|courses|kurs|student|teacher|tour|tours|hotel|antalya|iphone|eduflow|learnix|omoncrm|amocrm|bitrix)\b/iu;

describe('core isolation', () => {
  // This spec necessarily spells out the forbidden words itself.
  const sources = files(CORE)
    .filter((path) => !path.endsWith('architecture.spec.ts'))
    .map((path) => ({
      path: relative(process.cwd(), path),
      text: readFileSync(path, 'utf8'),
    }));

  it('scans the core sources', () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it.each(sources.map((source) => [source.path, source] as const))(
    '%s stays generic',
    (_path, source) => {
      for (const pattern of FORBIDDEN_IMPORTS)
        expect(source.text).not.toMatch(pattern);
      expect(source.text).not.toMatch(DOMAIN_WORDS);
    },
  );
});
