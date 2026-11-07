/**
 * Development only: creates (once) the local "Superadmin" web login.
 *
 *   pnpm dev:superadmin                    create if missing; never prints the password
 *   pnpm dev:superadmin --reset-password   generate a new password
 *   pnpm dev:superadmin --demo             also add 3 fictional conversations
 *
 * The password is random, stored hashed (scrypt) in the database and written
 * once to a file outside the repository (mode 0600, default
 * ~/.config/agentcore/dev-superadmin.password). It is never printed, logged or
 * committed. Refuses anything but NODE_ENV=development on a localhost database.
 */
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { assertLocalDevelopment } from '../src/dev/dev-guards.js';
import {
  assertOutsideRepository,
  ensureDemoConversations,
  ensureLocalSuperadmin,
  localSuperadminCredentials,
  SUPERADMIN_EMAIL,
  superadminPasswordFile,
  writeSecretFile,
} from '../src/dev/dev-superadmin.js';
import { createPostgresAdapter } from '../src/persistence/postgres-adapter.js';

const repoRoot = resolve(process.cwd(), '../..');
loadEnv({ path: resolve(repoRoot, '.env'), quiet: true });
assertLocalDevelopment(process.env);

const args = new Set(process.argv.slice(2));
const file = superadminPasswordFile(process.env);
assertOutsideRepository(file, repoRoot);
const configuredCredentials = localSuperadminCredentials(process.env);

const db = new PrismaClient({ adapter: createPostgresAdapter(process.env) });
try {
  const result = await ensureLocalSuperadmin(db, {
    reset: args.has('--reset-password'),
    email: configuredCredentials?.email,
    password: configuredCredentials?.password,
  });
  if (result.password && !configuredCredentials)
    await writeSecretFile(file, result.password);
  const demo = args.has('--demo')
    ? await ensureDemoConversations(db, result.tenantId)
    : 0;
  console.log(`Local Superadmin: ${result.status}`);
  console.log(
    `  login:    ${configuredCredentials ? 'configured by LOGIN' : SUPERADMIN_EMAIL}`,
  );
  if (configuredCredentials) {
    console.log('  password: configured by PASS (never printed)');
    if (result.status === 'unchanged' && !args.has('--reset-password'))
      console.log(
        '  existing password kept; use --reset-password to apply PASS',
      );
  } else {
    console.log(`  password: stored in ${file} (mode 0600, not printed)`);
    console.log('  copy it:  pbcopy < that file   (macOS)');
  }
  console.log(
    '  scope:    OWNER of one local tenant; no access to any other tenant',
  );
  if (args.has('--demo')) console.log(`  demo conversations added: ${demo}`);
  if (result.status === 'unchanged')
    console.log(
      '  (existing password kept; use --reset-password if the file is lost)',
    );
} finally {
  await db.$disconnect();
}
