/**
 * Ops command (ADR 052): pnpm ops:backfill-persons [tenant id]
 * Gives every contact without a person its own person. Idempotent.
 */
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import { backfillPersons } from './backfill-persons.js';

async function main(): Promise<void> {
  const [tenantId] = process.argv.slice(2);
  const db = new PrismaClient({ adapter: createPostgresAdapter(process.env) });
  try {
    const result = await backfillPersons(db, tenantId ? { tenantId } : {});
    console.log(
      `Persons backfill: ${result.contactsLinked} contacts linked, ${result.personsCreated} persons created, ${result.batches} batches`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
