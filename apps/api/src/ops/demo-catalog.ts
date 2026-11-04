import type { PrismaClient } from '../generated/prisma/client.js';
import { MOCK_CONNECTOR_KEY } from '../connectors/registry/registrations.js';

/** The mock's fixture set; its suffix is the pack the courses belong to. */
const DEMO_SOURCE = 'mock-education';
const DEMO_PACK = DEMO_SOURCE.slice('mock-'.length);

/**
 * Staging only (ADR 035 amendment 6): switches the fictional course catalog
 * (the mock connector) on or off for one tenant, so the agent can answer
 * catalog questions before a real catalog is connected. The mock never
 * creates leads, so a real CRM (Bitrix24) stays the lead sink. Refused unless
 * the server opted in with CONNECTOR_DEMO_CATALOG=on.
 */
export async function setDemoCatalog(
  db: PrismaClient,
  env: Readonly<Record<string, string | undefined>>,
  slug: string,
  on: boolean,
): Promise<'ACTIVE' | 'DISABLED'> {
  if (
    on &&
    env.NODE_ENV === 'production' &&
    env.CONNECTOR_DEMO_CATALOG !== 'on'
  )
    throw new Error(
      'CONNECTOR_DEMO_CATALOG=on is required: the demo catalog is for a test-data server only',
    );
  const tenant = await db.tenant.findUnique({
    where: { slug },
    select: { id: true, packKey: true },
  });
  if (!tenant) throw new Error(`No tenant with slug "${slug}"`);
  if (on && tenant.packKey !== DEMO_PACK)
    throw new Error(
      `Tenant "${slug}" uses pack "${tenant.packKey}"; the demo catalog has ${DEMO_PACK} courses only`,
    );
  const status = on ? 'ACTIVE' : 'DISABLED';
  await db.$transaction(async (tx) => {
    await tx.tenantConnector.upsert({
      where: {
        tenantId_connectorKey: {
          tenantId: tenant.id,
          connectorKey: MOCK_CONNECTOR_KEY,
        },
      },
      create: {
        tenantId: tenant.id,
        connectorKey: MOCK_CONNECTOR_KEY,
        status,
        config: { sourceSystem: DEMO_SOURCE, createLead: false },
      },
      update: {
        status,
        config: { sourceSystem: DEMO_SOURCE, createLead: false },
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actorType: 'ADMIN',
        action: on ? 'connector.demo_catalog_on' : 'connector.demo_catalog_off',
        entityType: 'tenant_connector',
        entityId: MOCK_CONNECTOR_KEY,
        safeInputSummary: { status },
      },
    });
  });
  return status;
}
