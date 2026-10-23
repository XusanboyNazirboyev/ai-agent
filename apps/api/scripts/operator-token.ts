import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { hashToken, newOperatorToken } from '../src/handover/operator-auth.js';
import { createPostgresAdapter } from '../src/persistence/postgres-adapter.js';

/**
 * pnpm operator:token <operatorId> <label>
 * Creates an API credential for an existing operator and prints it ONCE.
 * Only its SHA-256 is stored. The tenant comes from the operator row.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

async function main(): Promise<void> {
  const [operatorId, label] = process.argv.slice(2);
  if (!operatorId || !label)
    throw new Error('Usage: operator-token.ts <operatorId> <label>');
  const prisma = new PrismaClient({
    adapter: createPostgresAdapter(process.env),
  });
  try {
    const operator = await prisma.operator.findFirst({
      where: { id: operatorId, isActive: true },
      select: { id: true, tenantId: true },
    });
    if (!operator) throw new Error('No active operator with that id');
    const token = newOperatorToken();
    await prisma.operatorApiToken.create({
      data: {
        tenantId: operator.tenantId,
        operatorId: operator.id,
        tokenHash: hashToken(token),
        label: label.slice(0, 120),
      },
    });
    process.stdout.write(`${token}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Failed'}\n`,
  );
  process.exitCode = 1;
});
