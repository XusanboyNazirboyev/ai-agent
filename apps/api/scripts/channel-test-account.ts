/**
 * Development only: marks a channel account (for example one connected from
 * the web Channels page) as a test account, or back. There is no UI for this
 * by owner decision.
 *
 *   pnpm --filter @agentcore/api channel:test-account <tenant-slug> <channel-account-uuid> <on|off>
 *
 * Refuses anything but NODE_ENV=development on a localhost database. The
 * account must belong to the named tenant. A change is audited. Prints what
 * the agent would run for this account under the current settings.
 */
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  agentModePolicy,
  effectiveAgentMode,
} from '../src/agent/agent-mode.js';
import { validateEnvironment } from '../src/config/environment.js';
import { assertLocalDevelopment } from '../src/dev/dev-guards.js';
import {
  parseTestAccountArgs,
  setTestAccount,
} from '../src/dev/test-account.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPostgresAdapter } from '../src/persistence/postgres-adapter.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

async function main(): Promise<void> {
  assertLocalDevelopment(process.env);
  const args = parseTestAccountArgs(process.argv.slice(2));
  const policy = agentModePolicy(validateEnvironment(process.env));
  const db = new PrismaClient({ adapter: createPostgresAdapter(process.env) });
  try {
    const result = await setTestAccount(db, args);
    const effective = effectiveAgentMode(result.agentMode, policy, result);
    process.stdout.write(
      `Channel account ${args.accountId}: test account ${args.on ? 'on' : 'off'} (${result.status})\n` +
        `  agent mode ${result.agentMode}; runs now as ${effective.mode}\n`,
    );
    if (effective.mode === 'HOLD')
      process.stdout.write(
        '  HOLD: no model call and no reply; customers get no answer.\n',
      );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'channel:test-account failed'}\n`,
  );
  process.exitCode = 1;
});
