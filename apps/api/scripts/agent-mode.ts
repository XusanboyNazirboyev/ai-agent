import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  agentModePolicy,
  assertAgentModeAllowed,
  type AgentModeValue,
} from '../src/agent/agent-mode.js';
import { validateEnvironment } from '../src/config/environment.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPostgresAdapter } from '../src/persistence/postgres-adapter.js';

/**
 * Sets a channel account's agent mode:
 *   pnpm --filter @agentcore/api agent:mode <channel-account-uuid> <off|shadow|live>
 * LIVE is refused unless it is allowed (operator notifier, Phase 5; or
 * NODE_ENV=development for a local test bot) and never for an untrusted LLM
 * provider; SHADOW with an untrusted provider needs a test account or
 * LLM_ALLOW_REAL_CUSTOMER_DATA=true.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

async function main(): Promise<void> {
  const [accountId, rawMode] = process.argv.slice(2);
  const mode = rawMode?.toUpperCase() as AgentModeValue | undefined;
  if (!accountId || !mode || !['OFF', 'SHADOW', 'LIVE'].includes(mode)) {
    throw new Error(
      'Usage: agent-mode.ts <channel-account-uuid> <off|shadow|live>',
    );
  }
  const environment = validateEnvironment(process.env);
  const prisma = new PrismaClient({ adapter: createPostgresAdapter() });
  try {
    const account = await prisma.channelAccount.findFirst({
      where: { id: accountId },
      select: { isTestAccount: true },
    });
    if (!account) throw new Error('Unknown channel account');
    assertAgentModeAllowed(mode, agentModePolicy(environment), account);
    const updated = await prisma.channelAccount.updateMany({
      where: { id: accountId },
      data: { agentMode: mode },
    });
    if (updated.count !== 1) throw new Error('Unknown channel account');
    process.stdout.write(`Channel account ${accountId}: agent mode ${mode}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'agent-mode failed'}\n`,
  );
  process.exitCode = 1;
});
