/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AgentConversationService } from '../agent/agent-conversation.service.js';
import { LlmBudgetLedger } from '../agent/llm-budget-ledger.js';
import { LlmUsageStore } from '../agent/llm-usage.store.js';
import type { AppEnvironment } from '../config/environment.js';
import { backfillConnectorRoles } from '../connectors/connector-role-backfill.js';
import { ConnectorSelector } from '../connectors/connector-selector.js';
import { createConnectorRegistry } from '../connectors/connectors.module.js';
import type { CrmConnector } from '../connectors/interfaces/crm-connector.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { ConnectorRolesController } from './connector-roles.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Connector role tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});
afterEach(() => vi.restoreAllMocks());

const registry = createConnectorRegistry({
  NODE_ENV: 'test',
  CONNECTOR_OUTBOUND_POLICY: 'strict',
});
const loader = new TenantConnectorLoader(prisma, registry);
const selector = new ConnectorSelector(prisma, loader);
const controller = new ConnectorRolesController(prisma, selector, loader);

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

const MOCK_CONFIG = { sourceSystem: 'mock-education' };
const REST_CONFIG = {
  baseUrl: 'https://crm.example.test',
  endpoints: { searchItems: { path: '/search' } },
};
const REST_LEAD_ONLY_CONFIG = {
  baseUrl: 'https://crm.example.test',
  endpoints: { createLead: { method: 'POST', path: '/leads' } },
};

async function tenant(): Promise<{
  tenantId: string;
  as: (role: Role) => never;
  operatorId: string;
}> {
  const t = await db.tenant.create({
    data: {
      slug: `roles-${randomUUID()}`,
      name: 'Roles fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const op = await db.operator.create({
    data: { tenantId: t.id, displayName: 'Admin', role: 'ADMIN' },
  });
  return {
    tenantId: t.id,
    operatorId: op.id,
    as: (role) =>
      ({
        principal: {
          tenantId: t.id,
          operatorId: op.id,
          role,
          sessionId: randomUUID(),
        },
      }) as never,
  };
}

const addConnector = (
  tenantId: string,
  connectorKey: 'mock' | 'generic-rest',
  config: Record<string, unknown>,
  createdAt: Date,
  status: 'ACTIVE' | 'DISABLED' = 'ACTIVE',
) =>
  db.tenantConnector.create({
    data: {
      tenantId,
      connectorKey,
      status,
      config: config as never,
      createdAt,
    },
  });

/** A tenant with an older `mock` and a newer search-only `generic-rest`. */
async function twoConnectors() {
  const t = await tenant();
  const older = await addConnector(
    t.tenantId,
    'mock',
    MOCK_CONFIG,
    new Date('2026-01-01T00:00:00Z'),
  );
  const newer = await addConnector(
    t.tenantId,
    'generic-rest',
    REST_CONFIG,
    new Date('2026-02-01T00:00:00Z'),
  );
  return { ...t, older, newer };
}

const rejected = async (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected the call to be rejected');
    },
    (error: { getStatus(): number; getResponse(): { code?: string } }) => ({
      status: error.getStatus(),
      code: error.getResponse().code,
    }),
  );

describe('connector roles API (ADR 059)', () => {
  it('lists the three roles with status values', async () => {
    const t = await twoConnectors();
    const first = await controller.list(t.as('ADMIN'));
    expect(first.items.map((i) => [i.role, i.status])).toEqual([
      ['CATALOG', 'AMBIGUOUS'],
      ['LEAD_SINK', 'UNBOUND'],
      ['ACTIONS', 'UNBOUND'],
    ]);

    const bound = await controller.put(t.as('OWNER'), {
      role: 'CATALOG',
      tenantConnectorId: t.newer.id,
    });
    expect(bound).toEqual({
      role: 'CATALOG',
      tenantConnectorId: t.newer.id,
      connectorKey: 'generic-rest',
      status: 'BOUND',
    });

    await db.tenantConnector.update({
      where: { id: t.newer.id },
      data: { status: 'DISABLED' },
    });
    const after = await controller.list(t.as('ADMIN'));
    expect(after.items[0]).toEqual({
      role: 'CATALOG',
      tenantConnectorId: t.newer.id,
      connectorKey: 'generic-rest',
      status: 'UNAVAILABLE',
    });
  });

  it('allows OWNER and ADMIN and refuses OPERATOR and VIEWER', async () => {
    const t = await twoConnectors();
    for (const role of ['OWNER', 'ADMIN'] as const) {
      await controller.list(t.as(role));
      await controller.put(t.as(role), {
        role: 'LEAD_SINK',
        tenantConnectorId: t.older.id,
      });
    }
    for (const role of ['OPERATOR', 'VIEWER'] as const) {
      expect(
        await rejected(
          Promise.resolve().then(() => controller.list(t.as(role))),
        ),
      ).toMatchObject({
        status: 403,
      });
      expect(
        await rejected(
          controller.put(t.as(role), {
            role: 'LEAD_SINK',
            tenantConnectorId: null,
          }),
        ),
      ).toMatchObject({ status: 403 });
    }
  });

  it('refuses a connector of another tenant, a missing capability and a bad body', async () => {
    const a = await twoConnectors();
    const b = await twoConnectors();
    expect(
      await rejected(
        controller.put(a.as('ADMIN'), {
          role: 'CATALOG',
          tenantConnectorId: b.older.id,
        }),
      ),
    ).toEqual({ status: 404, code: 'NOT_FOUND' });
    // generic-rest here only searches: it cannot be the lead sink.
    expect(
      await rejected(
        controller.put(a.as('ADMIN'), {
          role: 'LEAD_SINK',
          tenantConnectorId: a.newer.id,
        }),
      ),
    ).toEqual({ status: 400, code: 'CONNECTOR_CAPABILITY_MISSING' });
    expect(
      await rejected(
        controller.put(a.as('ADMIN'), {
          role: 'NOPE',
          tenantConnectorId: null,
        }),
      ),
    ).toMatchObject({ status: 400, code: 'INVALID_BODY' });
    expect(
      await db.tenantConnectorRole.count({ where: { tenantId: a.tenantId } }),
    ).toBe(0);
  });

  it('refuses a connector that is not ACTIVE', async () => {
    const t = await tenant();
    const off = await addConnector(
      t.tenantId,
      'mock',
      MOCK_CONFIG,
      new Date(),
      'DISABLED',
    );
    expect(
      await rejected(
        controller.put(t.as('ADMIN'), {
          role: 'CATALOG',
          tenantConnectorId: off.id,
        }),
      ),
    ).toEqual({ status: 400, code: 'CONNECTOR_NOT_ACTIVE' });
  });

  it('rebinds, unbinds and audits ids and keys only', async () => {
    const t = await twoConnectors();
    await controller.put(t.as('ADMIN'), {
      role: 'CATALOG',
      tenantConnectorId: t.older.id,
    });
    await controller.put(t.as('ADMIN'), {
      role: 'CATALOG',
      tenantConnectorId: t.newer.id,
    });
    expect(
      await db.tenantConnectorRole.count({ where: { tenantId: t.tenantId } }),
    ).toBe(1);
    const unbound = await controller.put(t.as('ADMIN'), {
      role: 'CATALOG',
      tenantConnectorId: null,
    });
    expect(unbound).toEqual({
      role: 'CATALOG',
      tenantConnectorId: null,
      connectorKey: null,
      status: 'AMBIGUOUS',
    });
    // Unbinding an unbound role is a no-op.
    await controller.put(t.as('ADMIN'), {
      role: 'CATALOG',
      tenantConnectorId: null,
    });
    const audit = await db.auditEvent.findMany({
      where: {
        tenantId: t.tenantId,
        action: { startsWith: 'connector.role.' },
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'connector.role.bound',
      'connector.role.bound',
      'connector.role.unbound',
    ]);
    expect(audit[2]!.safeInputSummary).toEqual({
      role: 'CATALOG',
      connectorKey: 'generic-rest',
    });
    expect(JSON.stringify(audit)).not.toContain('crm.example.test');
  });
});

describe('connector role storage (ADR 059)', () => {
  it('the primary key forbids two connectors for one role', async () => {
    const t = await twoConnectors();
    await db.tenantConnectorRole.create({
      data: {
        tenantId: t.tenantId,
        role: 'CATALOG',
        tenantConnectorId: t.older.id,
      },
    });
    await expect(
      db.tenantConnectorRole.create({
        data: {
          tenantId: t.tenantId,
          role: 'CATALOG',
          tenantConnectorId: t.newer.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('the composite foreign key refuses another tenant connector', async () => {
    const a = await twoConnectors();
    const b = await twoConnectors();
    await expect(
      db.tenantConnectorRole.create({
        data: {
          tenantId: a.tenantId,
          role: 'CATALOG',
          tenantConnectorId: b.older.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('deleting the connector removes the binding', async () => {
    const t = await twoConnectors();
    await db.tenantConnectorRole.create({
      data: {
        tenantId: t.tenantId,
        role: 'CATALOG',
        tenantConnectorId: t.newer.id,
      },
    });
    await db.tenantConnector.delete({ where: { id: t.newer.id } });
    expect(
      await db.tenantConnectorRole.count({ where: { tenantId: t.tenantId } }),
    ).toBe(0);
  });
});

describe('selection against the database (ADR 059)', () => {
  it('a bound connector wins over an older one and never falls back', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const t = await twoConnectors();
    await controller.put(t.as('ADMIN'), {
      role: 'CATALOG',
      tenantConnectorId: t.newer.id,
    });
    const picked = await selector.select(t.tenantId, 'CATALOG');
    expect(picked?.connectorKey).toBe('generic-rest');
    await db.tenantConnector.update({
      where: { id: t.newer.id },
      data: { status: 'DISABLED' },
    });
    expect(await selector.select(t.tenantId, 'CATALOG')).toBeUndefined();
  });

  it('the agent catalog search uses the bound connector although an older one exists', async () => {
    const t = await twoConnectors();
    await controller.put(t.as('ADMIN'), {
      role: 'CATALOG',
      tenantConnectorId: t.newer.id,
    });
    const values: Partial<AppEnvironment> = {
      LLM_PROVIDER: 'mock',
      LLM_PRICING_VERSION: 'anthropic-2026-10-23',
    };
    const config = {
      get: (key: keyof AppEnvironment) => values[key],
    } as unknown as ConfigService<AppEnvironment, true>;
    const agent = new AgentConversationService(
      prisma,
      loader,
      new LlmUsageStore(prisma),
      new LlmBudgetLedger(prisma),
      {} as never,
      config,
    );
    const connectorFor = (
      agent as unknown as {
        connectorFor(tenantId: string): Promise<CrmConnector | undefined>;
      }
    ).connectorFor.bind(agent);
    expect((await connectorFor(t.tenantId))?.connectorKey).toBe('generic-rest');
  });
});

describe('backfill (ADR 059 decision 4)', () => {
  it('dry run reports and writes nothing; apply binds the oldest and reports ambiguity; a rerun changes nothing', async () => {
    const t = await tenant();
    await addConnector(
      t.tenantId,
      'mock',
      MOCK_CONFIG,
      new Date('2026-01-01T00:00:00Z'),
    );
    await addConnector(
      t.tenantId,
      'generic-rest',
      {
        ...REST_CONFIG,
        endpoints: {
          ...REST_CONFIG.endpoints,
          ...REST_LEAD_ONLY_CONFIG.endpoints,
        },
      },
      new Date('2026-02-01T00:00:00Z'),
    );
    const options = { prisma, loader, tenantIds: [t.tenantId] } as const;

    const dry = await backfillConnectorRoles({ ...options, apply: false });
    expect(
      await db.tenantConnectorRole.count({ where: { tenantId: t.tenantId } }),
    ).toBe(0);
    const catalog = dry.find((e) => e.role === 'CATALOG')!;
    expect(catalog).toMatchObject({
      action: 'BIND',
      connectorKey: 'mock',
      ambiguous: true,
      candidates: ['mock', 'generic-rest'],
    });

    const applied = await backfillConnectorRoles({ ...options, apply: true });
    expect(applied.filter((e) => e.action === 'BIND')).toHaveLength(3);
    const rows = await db.tenantConnectorRole.findMany({
      where: { tenantId: t.tenantId },
      include: { connector: true },
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.connector.connectorKey === 'mock')).toBe(true);

    const again = await backfillConnectorRoles({ ...options, apply: true });
    expect(again.every((e) => e.action === 'ALREADY_BOUND')).toBe(true);
    expect(
      await db.tenantConnectorRole.count({ where: { tenantId: t.tenantId } }),
    ).toBe(3);
  });
});
