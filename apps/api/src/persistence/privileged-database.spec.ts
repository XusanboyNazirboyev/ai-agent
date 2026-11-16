import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PrivilegedDatabase } from './privileged-database.js';
import type { PrismaService } from './prisma.service.js';

/**
 * Files allowed to use the privileged (cross-tenant) connection. Each new
 * entry is reviewed against the RLS plan: the code must span tenants (find
 * due work, route a webhook, look up a session) and then switch to the
 * tenant's own context for the work itself.
 */
const ALLOWED = new Set([
  'persistence/persistence.module.ts',
  'persistence/privileged-database.ts',
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'generated') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

const config = (values: Record<string, unknown>): never =>
  ({ get: (key: string): unknown => values[key] }) as never;

describe('privileged database (RLS plan S3)', () => {
  it('is used only where cross-tenant work is allowed', () => {
    const root = join(process.cwd(), 'src');
    const users = sources(root)
      .filter((path) =>
        readFileSync(path, 'utf8').includes('PrivilegedDatabase'),
      )
      .map((path) => relative(root, path));
    expect(users.filter((path) => !ALLOWED.has(path))).toEqual([]);
  });

  it('is the main connection until a privileged role is configured', () => {
    const main = { marker: 'main' } as unknown as PrismaService;
    const shared = new PrivilegedDatabase(config({}), main);
    expect(shared.db).toBe(main);
    expect(shared.separate).toBe(false);
  });

  it('opens its own pool as the configured role, defaults from the main settings', () => {
    const main = { marker: 'main' } as unknown as PrismaService;
    const own = new PrivilegedDatabase(
      config({
        POSTGRES_HOST: 'db',
        POSTGRES_PORT: 5432,
        POSTGRES_DATABASE: 'agentcore',
        POSTGRES_SSL_MODE: 'disable',
        POSTGRES_ADMIN_USER: 'owner_role',
        POSTGRES_ADMIN_PASSWORD: 'not-a-real-secret',
      }),
      main,
    );
    expect(own.separate).toBe(true);
    expect(own.db).not.toBe(main);
  });
});
