import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADR 047 §1: the platform console is the only code that reads across
 * tenants. Nothing outside `src/platform/**` may import it, except the
 * application root module that registers it.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORM = join(SRC, 'platform');
const ALLOWED = new Set([join(SRC, 'app.module.ts')]);

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory())
      return name === 'generated' ? [] : files(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const SPECIFIER =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gu;

function importsOf(source: string): string[] {
  return [...source.matchAll(SPECIFIER)]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter(Boolean);
}

describe('platform import boundary', () => {
  it('finds static and dynamic imports', () => {
    expect(
      importsOf(
        "import { A } from './a.js';\nexport { B } from \"../b.js\";\nawait import('./c.js');",
      ),
    ).toEqual(['./a.js', '../b.js', './c.js']);
  });

  it('no file outside src/platform imports from it (except app.module.ts)', () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      if (file.startsWith(PLATFORM + sep) || ALLOWED.has(file)) continue;
      for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier);
        if (target === PLATFORM || target.startsWith(PLATFORM + sep))
          offenders.push(`${relative(SRC, file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('app.module.ts is the one registered importer', () => {
    const source = readFileSync(join(SRC, 'app.module.ts'), 'utf8');
    expect(importsOf(source)).toContain('./platform/platform.module.js');
  });
});
