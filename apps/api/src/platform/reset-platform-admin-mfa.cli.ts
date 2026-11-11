/**
 * Server command: clears a platform admin's second factor (ADR 048).
 *   pnpm ops:platform-admin-reset-mfa --email owner@example.com
 * or, from the production image:
 *   node dist/platform/reset-platform-admin-mfa.cli.js --email ...
 * Prints only a confirmation, never a secret.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import {
  parseResetMfaArgs,
  resetPlatformAdminMfa,
} from './reset-platform-admin-mfa.js';

async function main(): Promise<void> {
  const envFile = process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const { email } = parseResetMfaArgs(process.argv.slice(2));
  const db = new PrismaClient({ adapter: createPostgresAdapter(process.env) });
  try {
    await resetPlatformAdminMfa(db, email);
  } finally {
    await db.$disconnect();
  }
  console.log(
    `MFA reset for platform admin ${email}: sessions revoked; they enrol again at the next sign-in.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
