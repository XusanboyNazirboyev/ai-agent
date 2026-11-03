import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Golden rule (AGENTS.md rule 1, Phase 7.4): `src/core/**` holds the generic
 * engine only. It reaches outside itself only for the connector contracts,
 * uses no vendor SDK, and contains no vertical- or CRM-specific words. A
 * Domain Pack is named only inside `src/packs/**`; everything else goes
 * through the registry (`src/packs/registry.ts`).
 */
const SRC = join(process.cwd(), 'src');
const CORE = join(SRC, 'core');
const PACKS = join(SRC, 'packs');

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

/** Every module a source names: static, side-effect, re-export, dynamic, require. */
export function specifiers(text: string): string[] {
  const found: string[] = [];
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/gu;
  for (const match of text.matchAll(pattern)) found.push(match[2]);
  return found;
}

/** The directories outside core that core may import from. */
const CORE_MAY_IMPORT = ['connectors/contracts', 'connectors/interfaces'].map(
  (dir) => join(SRC, dir),
);
/** The packages core may use; any vendor SDK is refused by omission. */
const CORE_PACKAGES = ['@agentcore/shared', 'zod'];
const TEST_PACKAGES = ['vitest'];

const inside = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(dir + sep);

/** What a core file must not import, as readable reasons. */
export function coreImportProblems(file: string, text: string): string[] {
  const test = file.endsWith('.spec.ts');
  return specifiers(text).flatMap((spec) => {
    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec);
      if (inside(target, CORE)) return [];
      return CORE_MAY_IMPORT.some((dir) => inside(target, dir))
        ? []
        : [`${spec} leaves core (${relative(SRC, target)})`];
    }
    if (spec.startsWith('node:')) return [];
    const name = spec.startsWith('@')
      ? spec.split('/').slice(0, 2).join('/')
      : spec.split('/')[0];
    const allowed = test ? [...CORE_PACKAGES, ...TEST_PACKAGES] : CORE_PACKAGES;
    return allowed.includes(name) ? [] : [`package ${spec} in core`];
  });
}

const DOMAIN_WORDS =
  /\b(?:ielts|course|courses|kurs|student|teacher|tour|tours|hotel|antalya|iphone|eduflow|learnix|omoncrm|amocrm|bitrix\d*)\b/iu;

/** Pack keys are the directory names under `src/packs/`. */
const PACK_KEYS = readdirSync(PACKS).filter((name) =>
  statSync(join(PACKS, name)).isDirectory(),
);

/**
 * Where a pack may be named outside `src/packs/**`: tests and their fixtures,
 * and the development-only tooling under `src/dev/` that seeds a local tenant
 * with a chosen pack. Production code reaches packs through the registry.
 */
const MAY_NAME_PACKS = (file: string): boolean =>
  file.endsWith('.spec.ts') ||
  file.split(sep).includes('testing') ||
  inside(file, join(SRC, 'dev'));

/** What a production file outside `src/packs/` must not do with a pack. */
export function packReferenceProblems(
  file: string,
  text: string,
  keys: readonly string[],
): string[] {
  const imports = specifiers(text).flatMap((spec) => {
    if (!spec.startsWith('.')) return [];
    const target = resolve(dirname(file), spec);
    if (!inside(target, PACKS)) return [];
    return target === join(PACKS, 'registry.js') ||
      target === join(PACKS, 'registry')
      ? []
      : [`${spec} imports a pack directly`];
  });
  const names = keys.flatMap((key) =>
    new RegExp(`(['"\`])${key}(?:@\\d+)?\\1`, 'u').test(text)
      ? [`names the pack '${key}'`]
      : [],
  );
  return [...imports, ...names];
}

describe('core isolation', () => {
  // This spec necessarily spells out the forbidden words itself.
  const sources = files(CORE)
    .filter((path) => !path.endsWith('architecture.spec.ts'))
    .map((path) => ({
      path,
      name: relative(process.cwd(), path),
      text: readFileSync(path, 'utf8'),
    }));

  it('scans the core sources', () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it.each(sources.map((source) => [source.name, source] as const))(
    '%s stays generic',
    (_name, source) => {
      expect(coreImportProblems(source.path, source.text)).toEqual([]);
      expect(source.text).not.toMatch(DOMAIN_WORDS);
    },
  );
});

describe('packs are named only in src/packs and reached through the registry', () => {
  it('every registered pack lives under src/packs/<key>/', async () => {
    const { DOMAIN_PACKS } = await import('../packs/registry.js');
    const keys = [...new Set([...DOMAIN_PACKS.values()].map((p) => p.key))];
    expect(keys.sort()).toEqual([...PACK_KEYS].sort());
  });

  const sources = files(SRC)
    .filter((path) => !inside(path, PACKS) && !MAY_NAME_PACKS(path))
    .map((path) => ({
      path,
      name: relative(process.cwd(), path),
      text: readFileSync(path, 'utf8'),
    }));

  it('scans the production sources outside src/packs', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it.each(sources.map((source) => [source.name, source] as const))(
    '%s names no pack',
    (_name, source) => {
      expect(
        packReferenceProblems(source.path, source.text, PACK_KEYS),
      ).toEqual([]);
    },
  );
});

describe('the checks themselves catch violations (sensitivity)', () => {
  const coreFile = join(CORE, 'agent', 'example.ts');
  const outsideFile = join(SRC, 'leads', 'example.ts');

  it('finds every form of import', () => {
    expect(
      specifiers(
        [
          "import { a } from './a.js';",
          "import './side-effect.js';",
          'export * from "./b.js";',
          "const c = await import('./c.js');",
          "const d = require('./d.js');",
        ].join('\n'),
      ),
    ).toEqual(['./a.js', './side-effect.js', './b.js', './c.js', './d.js']);
  });

  it('refuses core imports of packs, connector implementations and vendor SDKs', () => {
    for (const line of [
      "import { X } from '../../packs';",
      "import { X } from '../../packs/registry.js';",
      "import { X } from '../../connectors/bitrix24/bitrix24-connector.js';",
      "import { X } from '../../connectors/mock/mock-connector.js';",
      "const x = await import('../../connectors/registry/registrations.js');",
      "import { X } from '../../locales/locale-packs/uz.js';",
      "import { X } from '../../llm/anthropic/anthropic-llm-provider.js';",
      "import OpenAI from 'openai';",
      "import { GoogleGenAI } from '@google/genai';",
      "import { describe } from 'vitest';",
    ])
      expect(coreImportProblems(coreFile, line), line).not.toEqual([]);
  });

  it('allows what core legitimately uses', () => {
    expect(
      coreImportProblems(
        coreFile,
        [
          "import { a } from '../llm/llm-provider.js';",
          "import type { C } from '../../connectors/contracts/canonical.js';",
          "import { E } from '../../connectors/interfaces/errors.js';",
          "import type { DomainPack } from '@agentcore/shared';",
          "import { z } from 'zod';",
          "import { createHash } from 'node:crypto';",
        ].join('\n'),
      ),
    ).toEqual([]);
    expect(
      coreImportProblems(
        join(CORE, 'agent', 'example.spec.ts'),
        "import { it } from 'vitest';",
      ),
    ).toEqual([]);
  });

  it('catches the vertical and CRM words, including numbered names', () => {
    for (const word of ['course', 'Hotel', 'bitrix24', 'Bitrix', 'amoCRM'])
      expect(`const x = '${word} lead';`).toMatch(DOMAIN_WORDS);
    expect('const discourse = 1;').not.toMatch(DOMAIN_WORDS);
  });

  it('refuses a pack named or imported outside src/packs, but not the registry', () => {
    const keys = ['education', 'travel'];
    for (const line of [
      "if (tenant.packKey === 'education') {}",
      'const ref = "travel@1";',
      "import { EDUCATION_PACK } from '../packs/education/education.pack.js';",
    ])
      expect(packReferenceProblems(outsideFile, line, keys), line).not.toEqual(
        [],
      );
    expect(
      packReferenceProblems(
        outsideFile,
        "import { DOMAIN_PACKS } from '../packs/registry.js';\nconst note = 'continuing education';",
        keys,
      ),
    ).toEqual([]);
  });
});
