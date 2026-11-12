import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR 054 decision 2: only transaction-local settings are allowed. A
 * session-level `set_config(..., false)` would leak a tenant through the pool.
 * Spec files are allow-listed (they may show the forbidden form as text).
 */
const SESSION_LEVEL =
  /set_config\s*\(\s*'[^']*'\s*,[\s\S]{0,300}?,\s*false\s*\)/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === 'generated' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

describe('set_config guard (ADR 054)', () => {
  it('detects the session-level form and ignores the transaction-local one', () => {
    expect(
      SESSION_LEVEL.test(`SELECT set_config('app.tenant_id', \${id}, false)`),
    ).toBe(true);
    expect(
      SESSION_LEVEL.test(`SELECT set_config('app.tenant_id', $1,\n  false )`),
    ).toBe(true);
    expect(
      SESSION_LEVEL.test(`SELECT set_config('app.tenant_id', \${id}, true)`),
    ).toBe(false);
  });

  it('no non-spec file under apps/api/src uses set_config(..., false)', () => {
    const offenders = sourceFiles(resolve(process.cwd(), 'src')).filter((f) =>
      SESSION_LEVEL.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
