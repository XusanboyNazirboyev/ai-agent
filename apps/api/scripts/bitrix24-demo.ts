/**
 * Demo: a simulated conversation creates a lead in the owner's Bitrix24 TEST
 * portal (synthetic data only).
 *
 *   SIM_POSTGRES_DATABASE=agentcore_bitrix24_demo pnpm --filter @agentcore/api exec tsx scripts/bitrix24-demo.ts
 *
 * 1. A scripted customer asks for a person (scenario edu-22) through the real
 *    v1 pipeline with a scripted model, so a lead is recorded.
 * 2. The tenant keeps the mock catalog (lead creation switched off) and gets
 *    the bitrix24 connector as its lead sink.
 * 3. The real LeadSyncService syncs the lead (ADR 023 operation record), then
 *    syncs it again (no second CRM lead), then a second conversation with the
 *    same synthetic phone takes the duplicate path (comment on that lead).
 *
 * The webhook URL is read from CONNECTOR_SECRET_BITRIX24_WEBHOOK_URL, falling
 * back to the older name BITRIX24_WEBHOOK_URL (copied in-process); it is never
 * printed.
 */
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createConnectorRegistry } from '../src/connectors/connectors.module.js';
import { TenantConnectorLoader } from '../src/connectors/sync/tenant-connector-loader.js';
import { isConnectorError } from '../src/connectors/interfaces/errors.js';
import { ScriptedLlmProvider } from '../src/core/llm/scripted-llm-provider.js';
import { extraction } from '../src/agent/testing/agent-harness.js';
import { EVAL_PACKS } from '../src/agent/testing/eval-runner.js';
import { ScriptedCustomer } from '../src/agent/testing/simulation/customer.js';
import { runScenario } from '../src/agent/testing/simulation/runner.js';
import { loadScenarios } from '../src/agent/testing/simulation/scenario.js';
import { simulationSettings } from '../src/agent/testing/simulation/world.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { findDemoLead } from '../src/connectors/bitrix24/testing/demo-lead.js';
import { LeadSyncService } from '../src/leads/lead-sync.service.js';
import { createPostgresAdapter } from '../src/persistence/postgres-adapter.js';
import type { PrismaService } from '../src/persistence/prisma.service.js';

const root = resolve(process.cwd(), '../..');
loadEnv({ path: resolve(root, '.env'), quiet: true });
const SECRET = 'CONNECTOR_SECRET_BITRIX24_WEBHOOK_URL';
process.env[SECRET] ||= process.env.BITRIX24_WEBHOOK_URL ?? '';
const PHONE = '+998900000021';

async function conversation(
  db: PrismaClient,
  label: string,
): Promise<{
  tenantId: string;
  leadId: string;
}> {
  const scenario = loadScenarios(resolve(root, 'eval/scenarios')).find(
    (s) => s.id === 'edu-22',
  )!;
  const result = await runScenario({
    db,
    scenario,
    language: 'en',
    run: 1,
    provider: new ScriptedLlmProvider([
      extraction({}, 'human_request', 'en', 'Latn', EVAL_PACKS.education),
    ]),
    customer: new ScriptedCustomer(scenario, 'en'),
    settings: simulationSettings({}),
  });
  // Only the tenant this run created (never "the newest lead anywhere").
  const lead = await findDemoLead(db, result.tenantId);
  if (!lead) throw new Error(`${label}: the conversation recorded no lead`);
  console.log(
    `${label}: simulated conversation ended by ${result.endedBy}; lead recorded`,
  );
  await db.contact.update({
    where: { id: lead.contactId },
    data: { name: `Demo Synthetic ${label}`, phone: PHONE },
  });
  // Mock stays the catalog; Bitrix24 becomes the lead sink.
  await db.tenantConnector.updateMany({
    where: { tenantId: lead.tenantId, connectorKey: 'mock' },
    data: { config: { sourceSystem: 'mock-education', createLead: false } },
  });
  await db.tenantConnector.create({
    data: {
      tenantId: lead.tenantId,
      connectorKey: 'bitrix24',
      status: 'ACTIVE',
      config: { webhookSecretRef: `env:${SECRET}`, sourceId: 'OTHER' },
    },
  });
  return { tenantId: lead.tenantId, leadId: lead.id };
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Development only.');
  if (!process.env[SECRET])
    throw new Error('No Bitrix24 webhook variable set.');
  const database = process.env.SIM_POSTGRES_DATABASE ?? '';
  if (
    !/^agentcore_[a-z0-9_]+$/u.test(database) ||
    database === process.env.POSTGRES_DATABASE ||
    database === 'agentcore_test'
  )
    throw new Error(
      'SIM_POSTGRES_DATABASE must be a dedicated agentcore_* database.',
    );
  const db = new PrismaClient({
    adapter: createPostgresAdapter({
      ...process.env,
      POSTGRES_DATABASE: database,
    }),
  });
  try {
    const registry = createConnectorRegistry({
      NODE_ENV: 'development',
      CONNECTOR_OUTBOUND_POLICY: 'strict',
    });
    const prisma = db as unknown as PrismaService;
    const sync = new LeadSyncService(
      prisma,
      new TenantConnectorLoader(prisma, registry),
    );
    const show = async (
      label: string,
      tenantId: string,
      leadId: string,
    ): Promise<void> => {
      const outcome = await sync.sync(tenantId, leadId);
      const lead = await db.lead.findFirst({
        where: { id: leadId, tenantId },
        select: { crmSyncStatus: true, crmLeadId: true, lastErrorCode: true },
      });
      const ops = await db.connectorOperation.findMany({
        where: { tenantId, subjectId: leadId },
        select: { status: true, attemptMode: true },
      });
      console.log(
        `${label}: sync ${outcome}; lead ${lead?.crmSyncStatus} Bitrix24 id ${lead?.crmLeadId ?? '-'}${lead?.lastErrorCode ? ` (${lead.lastErrorCode})` : ''}; operations ${JSON.stringify(ops)}`,
      );
    };
    const a = await conversation(db, 'A');
    await show('A first sync', a.tenantId, a.leadId);
    await show('A second sync (same lead)', a.tenantId, a.leadId);
    const b = await conversation(db, 'B');
    await show('B (same phone: duplicate path)', b.tenantId, b.leadId);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    isConnectorError(error)
      ? `demo failed: ${error.code}`
      : error instanceof Error && !/https?:/u.test(error.message)
        ? `demo failed: ${error.message}`
        : 'demo failed',
  );
  process.exitCode = 1;
});
