import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertLocalDevelopment } from './dev-guards.js';
import {
  assertOutsideRepository,
  generatePassword,
  superadminPasswordFile,
  writeSecretFile,
} from './dev-superadmin.js';

describe('local superadmin helpers', () => {
  it('generates long random passwords that differ on every call', () => {
    const a = generatePassword();
    expect(a.length).toBeGreaterThanOrEqual(24);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(generatePassword()).not.toBe(a);
  });

  it('writes the secret with owner-only permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentcore-secret-'));
    const file = join(dir, 'nested', 'pw');
    await writeSecretFile(file, 'value-1');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'nested'))).mode & 0o777).toBe(0o700);
    await writeSecretFile(file, 'value-2');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toBe('value-2\n');
  });

  it('refuses a credential file inside the repository', () => {
    expect(() => assertOutsideRepository('/repo/apps/api/pw', '/repo')).toThrow(
      /inside the repository/u,
    );
    expect(() => assertOutsideRepository('/repo', '/repo')).toThrow();
    expect(() =>
      assertOutsideRepository('/home/u/.config/agentcore/pw', '/repo'),
    ).not.toThrow();
    expect(() =>
      assertOutsideRepository('/repository-x/pw', '/repo'),
    ).not.toThrow();
  });

  it('keeps the file in the home config directory unless overridden', () => {
    expect(superadminPasswordFile({})).toMatch(
      /\.config\/agentcore\/dev-superadmin\.password$/u,
    );
    expect(
      superadminPasswordFile({ AGENTCORE_DEV_SECRETS_DIR: '/tmp/x' }),
    ).toBe('/tmp/x/dev-superadmin.password');
  });

  it('is only allowed in development against a local database', () => {
    expect(() =>
      assertLocalDevelopment({
        NODE_ENV: 'production',
        POSTGRES_HOST: 'localhost',
      }),
    ).toThrow();
    expect(() =>
      assertLocalDevelopment({
        NODE_ENV: 'development',
        POSTGRES_HOST: 'db.example.com',
      }),
    ).toThrow();
    expect(() =>
      assertLocalDevelopment({
        NODE_ENV: 'development',
        POSTGRES_HOST: 'localhost',
      }),
    ).not.toThrow();
  });
});
