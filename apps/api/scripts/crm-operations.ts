/**
 * Operator recovery for CRM writes whose outcome is UNCERTAIN (ADR 023): the
 * CRM may or may not have the record and nothing could tell automatically.
 * A person checks the CRM, then records what they found. Tenant-scoped and
 * audited; prints ids and states only (no customer data).
 *
 *   pnpm crm:operations list <tenantId>
 *   pnpm crm:operations resolve <tenantId> <leadId> succeeded <crmLeadId> <actor>
 *   pnpm crm:operations resolve <tenantId> <leadId> failed <actor>
 */
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { TenantConnectorLoader } from '../src/connectors/sync/tenant-connector-loader.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { LeadSyncService } from '../src/leads/lead-sync.service.js';
import { createPostgresAdapter } from '../src/persistence/postgres-adapter.js';
import type { PrismaService } from '../src/persistence/prisma.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
const [command, tenantId, ...rest] = process.argv.slice(2);
const UUID = /^[0-9a-f-]{36}$/iu;
if (!tenantId || !UUID.test(tenantId)) {
  console.log(
    'usage: list <tenantId> | resolve <tenantId> <leadId> succeeded <crmLeadId> <actor> | resolve <tenantId> <leadId> failed <actor>',
  );
  process.exit(2);
}
const prisma = new PrismaClient({ adapter: createPostgresAdapter() });
try {
  if (command === 'list') {
    const rows = await prisma.connectorOperation.findMany({
      where: { tenantId, status: 'UNCERTAIN' },
      orderBy: { updatedAt: 'asc' },
      select: {
        subjectType: true,
        subjectId: true,
        kind: true,
        attempts: true,
        lastErrorCode: true,
        idempotencyKey: true,
        updatedAt: true,
      },
    });
    for (const row of rows) console.log(JSON.stringify(row));
    console.log(`${rows.length} uncertain operation(s)`);
  } else if (command === 'resolve') {
    const [leadId, outcome, ...tail] = rest;
    if (
      !leadId ||
      !UUID.test(leadId) ||
      !['succeeded', 'failed'].includes(outcome ?? '')
    )
      process.exit(2);
    const crmLeadId = outcome === 'succeeded' ? tail[0] : undefined;
    const actor = outcome === 'succeeded' ? tail[1] : tail[0];
    if (!actor) process.exit(2);
    // Resolution never calls a connector: the loader is not used.
    const sync = new LeadSyncService(
      prisma as unknown as PrismaService,
      {} as TenantConnectorLoader,
    );
    const result = await sync.resolveUncertain({
      tenantId,
      leadId,
      outcome: outcome === 'succeeded' ? 'SUCCEEDED' : 'FAILED',
      crmLeadId,
      actor,
    });
    console.log(result);
    process.exit(result === 'RESOLVED' ? 0 : 1);
  } else {
    process.exit(2);
  }
} finally {
  await prisma.$disconnect();
}
