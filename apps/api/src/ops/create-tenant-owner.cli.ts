/**
 * Server command: creates a tenant and its first OWNER login (ADR 035).
 * Runs from the production image, e.g. through deploy/create-owner.sh:
 *   node dist/ops/create-tenant-owner.cli.js --slug ... --password-file /out/x
 * The password is written to the file (which must not exist yet) before the
 * database is touched, so a login never exists without its password on disk;
 * the file is removed again if creation fails.
 */
import { unlink } from 'node:fs/promises';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import {
  createTenantOwner,
  generateOwnerPassword,
  parseTenantOwnerArgs,
  writePasswordFile,
} from './tenant-owner.js';

async function main(): Promise<void> {
  const { passwordFile, ...input } = parseTenantOwnerArgs(
    process.argv.slice(2),
  );
  const password = generateOwnerPassword();
  await writePasswordFile(passwordFile, password);
  const db = new PrismaClient({ adapter: createPostgresAdapter(process.env) });
  try {
    await createTenantOwner(db, input, { password });
  } catch (error) {
    await unlink(passwordFile).catch(() => undefined);
    throw error;
  } finally {
    await db.$disconnect();
  }
  console.log(`Tenant created: ${input.slug} (${input.pack})`);
  console.log(`  owner login: ${input.email}`);
  console.log(
    `  password:    written to ${passwordFile} (mode 0600, not printed)`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
