/**
 * Server command (staging only, ADR 035 amendment 6):
 *   node dist/ops/demo-catalog.cli.js <tenant slug> on|off
 * Turns the fictional course catalog on or off for one tenant.
 */
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import { setDemoCatalog } from './demo-catalog.js';

async function main(): Promise<void> {
  const [slug, switchTo] = process.argv.slice(2);
  if (!slug || (switchTo !== 'on' && switchTo !== 'off'))
    throw new Error('usage: demo-catalog <tenant slug> on|off');
  const db = new PrismaClient({ adapter: createPostgresAdapter(process.env) });
  try {
    const status = await setDemoCatalog(
      db,
      process.env,
      slug,
      switchTo === 'on',
    );
    console.log(`Demo catalog for "${slug}": ${status}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
