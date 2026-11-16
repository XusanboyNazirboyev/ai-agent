import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PrivilegedDatabase } from './privileged-database.js';
import { PersistenceModule } from './persistence.module.js';
import { PrismaService } from './prisma.service.js';

/**
 * Files allowed to use the privileged (cross-tenant) connection. Each new
 * entry is reviewed against the RLS plan: the code must span tenants (find
 * due work, route a webhook, look up a session) and then switch to the
 * tenant's own context for the work itself.
 */
const ALLOWED = new Map([
  ['persistence/persistence.module.ts', 'provides it'],
  ['persistence/privileged-database.ts', 'defines it'],
  // S5: identity is looked up before any tenant is known.
  ['webinbox/session.service.ts', 'login by e-mail, session by cookie hash'],
  ['auth/mfa.service.ts', 'second factor of a person not yet signed in'],
  ['team/operator-invite.service.ts', 'invite found by its token alone'],
  // S5: a webhook names the account; one lookup finds its tenant.
  ['channels/telegram/telegram-webhook.service.ts', 'route an update'],
  ['channels/instagram/instagram-webhook.service.ts', 'route a Meta event'],
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
    // A stale entry would quietly allow a future use: keep the list exact.
    expect([...ALLOWED.keys()].filter((path) => !users.includes(path))).toEqual(
      [],
    );
  });

  it('comes from the same module as PrismaService, so services may take it as optional', () => {
    // Services fall back to PrismaService only when a spec builds them by
    // hand; under Nest both are always provided together.
    const exports = Reflect.getMetadata(
      'exports',
      PersistenceModule,
    ) as unknown[];
    expect(exports).toContain(PrismaService);
    expect(exports).toContain(PrivilegedDatabase);
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
