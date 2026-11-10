/**
 * Server command: creates a platform console admin (ADR 047 §1).
 *   pnpm ops:platform-admin --email a@b.c --name "Owner" --password-file /out/x
 * or, from the production image:
 *   node dist/platform/create-platform-admin.cli.js --email ... --password-file ...
 * The password is written to the file (which must not exist yet) before the
 * database is touched and the file is removed again if creation fails. It is
 * never printed.
 */
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PrismaClient } from '../generated/prisma/client.js';
import {
  generateOwnerPassword,
  writePasswordFile,
} from '../ops/tenant-owner.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import {
  createPlatformAdmin,
  parsePlatformAdminArgs,
} from './platform-admin.js';

async function main(): Promise<void> {
  // Same env file as the API (AppModule); existing variables win.
  const envFile = process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const { passwordFile, ...input } = parsePlatformAdminArgs(
    process.argv.slice(2),
  );
  const password = generateOwnerPassword();
  await writePasswordFile(passwordFile, password);
  const db = new PrismaClient({ adapter: createPostgresAdapter(process.env) });
  try {
    await createPlatformAdmin(db, input, { password });
  } catch (error) {
    await unlink(passwordFile).catch(() => undefined);
    throw error;
  } finally {
    await db.$disconnect();
  }
  console.log(`Platform admin created: ${input.email} (${input.role})`);
  console.log(
    `  password: written to ${passwordFile} (mode 0600, not printed)`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
