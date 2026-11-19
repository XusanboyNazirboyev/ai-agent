/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LeadArchiveService } from '../leads/lead-archive.service.js';
import { ensureLeadStages } from '../leads/lead-stage.util.js';
import { ManualLeadService } from '../leads/manual-lead.service.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../persistence/testing/test-clients.js';
import { CustomFieldsService } from '../tags/custom-fields.service.js';
import { TagsService } from '../tags/tags.service.js';
import { LeadPipelineController } from '../webinbox/lead-pipeline.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Lead one integration tests require agentcore_test');
}
const db = ownerClient();
const app = appClient();
const prisma = app as unknown as PrismaService;
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

const leadsApi = tenantScoped(
  new LeadPipelineController(
    prisma,
    new TagsService(prisma),
    new CustomFieldsService(prisma),
    new ManualLeadService(prisma),
    new LeadArchiveService(prisma),
  ),
);

async function tenantWithOwner() {
  const tenant = await db.tenant.create({
    data: {
      slug: `lo-${randomUUID()}`,
      name: 'Lead one fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'test',
      packVersion: '1',
    },
  });
  const op = await db.operator.create({
    data: { tenantId: tenant.id, displayName: 'Op', role: 'OWNER' },
  });
  await db.$transaction((tx) => ensureLeadStages(tx, tenant.id));
  const as = {
    principal: {
      tenantId: tenant.id,
      operatorId: op.id,
      role: 'OWNER',
      sessionId: randomUUID(),
    },
  } as never;
  return { tenantId: tenant.id, as };
}

const status = (promise: Promise<unknown>) =>
  promise.then(
    () => 0,
    (error: { getStatus(): number }) => error.getStatus(),
  );

describe('GET /leads/:id', () => {
  it('returns the list item shape, archived marker included', async () => {
    const w = await tenantWithOwner();
    const created = (await leadsApi.createManually(w.as, {
      name: 'Single Lead',
      phone: '+998901112233',
    })) as { id: string };
    const one = await leadsApi.one(w.as, created.id);
    const page = await leadsApi.list(w.as, {});
    const fromList = page.items.find((i) => i.id === created.id);
    expect(one).toEqual(fromList);
    expect(one.contact.name).toBe('Single Lead');
    expect(one.conversation.channelType).toBe('manual');

    await db.lead.update({
      where: { tenantId_id: { tenantId: w.tenantId, id: created.id } },
      data: { archivedAt: new Date() },
    });
    const archived = await leadsApi.one(w.as, created.id);
    expect(archived.archivedAt).not.toBeNull();
  });

  it('is 404 for a missing lead and for another tenant lead', async () => {
    const a = await tenantWithOwner();
    const b = await tenantWithOwner();
    const lead = (await leadsApi.createManually(a.as, {
      name: 'A only',
    })) as { id: string };
    expect(await status(leadsApi.one(b.as, lead.id))).toBe(404);
    expect(await status(leadsApi.one(a.as, randomUUID()))).toBe(404);
  });
});
