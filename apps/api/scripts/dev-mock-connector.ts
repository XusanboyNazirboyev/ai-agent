/**
 * Development only: gives one local tenant an ACTIVE `mock` catalog connector
 * (fictional education courses, no real data), so a test bot can answer from a
 * catalog with provenance instead of handing every question over as NO_DATA.
 * Without an ACTIVE connector that can search, a turn ends as NO_DATA
 * (agent-turn.ts: the `search_catalog` tool is not offered).
 *
 *   pnpm --filter @agentcore/api dev:mock-connector [tenant-slug]
 *
 * Default tenant: `dev-local-superadmin`. Idempotent; refuses production and
 * non-local databases; touches only this tenant's `mock` connector row.
 */
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPostgresAdapter } from '../src/persistence/postgres-adapter.js';
import { assertLocalDevelopment } from '../src/dev/dev-guards.js';

loadEnv({ path: resolve(process.cwd(), '../../.env') });
assertLocalDevelopment(process.env);

const slug = process.argv[2] ?? 'dev-local-superadmin';
const prisma = new PrismaClient({ adapter: createPostgresAdapter() });
try {
  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    select: { id: true, packKey: true },
  });
  if (!tenant) {
    console.log(`No tenant with slug "${slug}" in this database.`);
    process.exitCode = 2;
  } else if (tenant.packKey !== 'education') {
    console.log(
      `Tenant "${slug}" uses pack "${tenant.packKey}"; the mock catalog is education only.`,
    );
    process.exitCode = 2;
  } else {
    const row = await prisma.tenantConnector.upsert({
      where: {
        tenantId_connectorKey: { tenantId: tenant.id, connectorKey: 'mock' },
      },
      create: {
        tenantId: tenant.id,
        connectorKey: 'mock',
        status: 'ACTIVE',
        config: { sourceSystem: 'mock-education' },
      },
      update: { status: 'ACTIVE' },
    });
    console.log(
      `Mock connector ${row.status} for tenant "${slug}" (fictional courses).`,
    );
  }
} finally {
  await prisma.$disconnect();
}
