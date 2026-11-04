import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import { setDemoCatalog } from './demo-catalog.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('requires agentcore_test');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
afterAll(async () => db.$disconnect());

const STAGING = { NODE_ENV: 'production', CONNECTOR_DEMO_CATALOG: 'on' };

async function tenant(packKey: string): Promise<{ id: string; slug: string }> {
  const slug = `demo-catalog-${randomUUID().slice(0, 8)}`;
  const row = await db.tenant.create({
    data: {
      slug,
      name: 'Demo catalog fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Etc/UTC',
      packKey,
      packVersion: '1',
    },
  });
  return { id: row.id, slug };
}

async function mockRow(tenantId: string): Promise<unknown> {
  return db.tenantConnector.findUnique({
    where: { tenantId_connectorKey: { tenantId, connectorKey: 'mock' } },
    select: { status: true, config: true },
  });
}

describe('demo catalog switch (staging)', () => {
  it('turns the fictional catalog on without lead creation, then off, audited', async () => {
    const { id, slug } = await tenant('education');
    await expect(setDemoCatalog(db, STAGING, slug, true)).resolves.toBe(
      'ACTIVE',
    );
    expect(await mockRow(id)).toEqual({
      status: 'ACTIVE',
      config: { sourceSystem: 'mock-education', createLead: false },
    });
    await expect(setDemoCatalog(db, STAGING, slug, false)).resolves.toBe(
      'DISABLED',
    );
    expect(await mockRow(id)).toMatchObject({ status: 'DISABLED' });
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: id,
          action: { startsWith: 'connector.demo_catalog' },
        },
      }),
    ).toBe(2);
  });

  it('refuses a production server without the opt-in and a non-education tenant', async () => {
    const { id, slug } = await tenant('education');
    await expect(
      setDemoCatalog(db, { NODE_ENV: 'production' }, slug, true),
    ).rejects.toThrow(/CONNECTOR_DEMO_CATALOG=on/);
    expect(await mockRow(id)).toBeNull();
    const other = await tenant('travel');
    await expect(setDemoCatalog(db, STAGING, other.slug, true)).rejects.toThrow(
      /education courses only/,
    );
    await expect(
      setDemoCatalog(db, STAGING, 'no-such-tenant', true),
    ).rejects.toThrow(/No tenant/);
  });
});
