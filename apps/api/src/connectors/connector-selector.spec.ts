import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantConnector } from '../generated/prisma/client.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { ConnectorSelector } from './connector-selector.js';
import type {
  ConnectorCapabilities,
  CrmConnector,
} from './interfaces/crm-connector.js';
import type { TenantConnectorLoader } from './sync/tenant-connector-loader.js';

const TENANT = 'tenant-1';

function row(
  key: string,
  patch: Partial<TenantConnector> = {},
): TenantConnector {
  return {
    id: `id-${key}`,
    tenantId: TENANT,
    connectorKey: key,
    status: 'ACTIVE',
    config: {},
    capabilities: [],
    secretRef: null,
    createdAt: new Date(2026, 0, 1),
    updatedAt: new Date(2026, 0, 1),
    ...patch,
  } as TenantConnector;
}

function connector(caps: Partial<ConnectorCapabilities>): CrmConnector {
  const all: ConnectorCapabilities = {
    sync: false,
    search: false,
    liveQuote: false,
    availability: false,
    createLead: false,
    updateLead: false,
    createBooking: false,
    webhooks: false,
    ...caps,
  };
  return {
    key: 'fake',
    capabilities: all,
    createLead: () => Promise.resolve(),
    createBooking: () => Promise.resolve(),
    updateLead: () => Promise.resolve(),
    searchItems: () => Promise.resolve([]),
  } as unknown as CrmConnector;
}

interface Setup {
  selector: ConnectorSelector;
  warn: ReturnType<typeof vi.spyOn>;
}

function setup(options: {
  bound?: { role: string; connector: TenantConnector };
  rows: TenantConnector[];
  caps: Record<string, Partial<ConnectorCapabilities> | 'throws'>;
}): Setup {
  const prisma = {
    tenantConnectorRole: {
      findFirst: vi.fn(({ where }: { where: { role: string } }) =>
        Promise.resolve(
          options.bound && options.bound.role === where.role
            ? { connector: options.bound.connector }
            : null,
        ),
      ),
    },
    tenantConnector: {
      findMany: vi.fn(() => Promise.resolve(options.rows)),
    },
  } as unknown as PrismaService;
  const loader = {
    create: vi.fn((r: TenantConnector) => {
      const spec = options.caps[r.connectorKey];
      if (spec === 'throws' || !spec)
        return Promise.reject(new Error('CONNECTOR_INVALID_CONFIG'));
      return Promise.resolve(connector(spec));
    }),
  } as unknown as TenantConnectorLoader;
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  return { selector: new ConnectorSelector(prisma, loader), warn };
}

const events = (warn: Setup['warn']): string[] =>
  warn.mock.calls.map(
    (call) => (JSON.parse(call[0] as string) as { event: string }).event,
  );

afterEach(() => vi.restoreAllMocks());

describe('ConnectorSelector (ADR 059)', () => {
  it('uses the bound connector even when an older capable one exists', async () => {
    const old = row('old');
    const bound = row('bound', { createdAt: new Date(2026, 5, 1) });
    const { selector } = setup({
      bound: { role: 'CATALOG', connector: bound },
      rows: [old, bound],
      caps: { old: { search: true }, bound: { search: true } },
    });
    const picked = await selector.resolve(TENANT, 'CATALOG');
    expect(picked.kind).toBe('BOUND');
    if (picked.kind === 'BOUND') expect(picked.row.connectorKey).toBe('bound');
  });

  it('a bound connector that is not ACTIVE yields undefined and no fallback', async () => {
    const { selector, warn } = setup({
      bound: { role: 'CATALOG', connector: row('b', { status: 'DISABLED' }) },
      rows: [row('other')],
      caps: { b: { search: true }, other: { search: true } },
    });
    expect(await selector.select(TENANT, 'CATALOG')).toBeUndefined();
    expect(events(warn)).toEqual(['connector.bound_unavailable']);
  });

  it('a bound connector whose config fails to load yields undefined and no fallback', async () => {
    const { selector, warn } = setup({
      bound: { role: 'LEAD_SINK', connector: row('b') },
      rows: [row('other')],
      caps: { b: 'throws', other: { createLead: true } },
    });
    expect(await selector.select(TENANT, 'LEAD_SINK')).toBeUndefined();
    expect(events(warn)).toEqual(['connector.bound_unavailable']);
  });

  it('a bound connector without the capability yields undefined and no fallback', async () => {
    const { selector, warn } = setup({
      bound: { role: 'CATALOG', connector: row('b') },
      rows: [row('other')],
      caps: { b: { createLead: true }, other: { search: true } },
    });
    expect(await selector.select(TENANT, 'CATALOG')).toBeUndefined();
    expect(events(warn)).toEqual(['connector.bound_unavailable']);
  });

  it('an unbound role uses the single capable ACTIVE connector', async () => {
    const { selector, warn } = setup({
      rows: [row('a'), row('b')],
      caps: { a: { createLead: true }, b: { search: true } },
    });
    expect(await selector.select(TENANT, 'CATALOG')).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('an unbound role with two capable connectors fails closed and logs the candidates', async () => {
    const { selector, warn } = setup({
      rows: [row('a'), row('b')],
      caps: { a: { search: true }, b: { search: true } },
    });
    expect(await selector.select(TENANT, 'CATALOG')).toBeUndefined();
    expect(events(warn)).toEqual(['connector.ambiguous']);
    const logged = JSON.parse(warn.mock.calls[0]![0] as string) as {
      candidates: string[];
    };
    expect(logged.candidates).toEqual(['a', 'b']);
  });

  it('an unbound role with no capable connector is undefined without a warning', async () => {
    const { selector, warn } = setup({
      rows: [row('a')],
      caps: { a: { createLead: true } },
    });
    expect(await selector.select(TENANT, 'CATALOG')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a connector that cannot load is not a candidate for an unbound role', async () => {
    const { selector } = setup({
      rows: [row('broken'), row('good')],
      caps: { broken: 'throws', good: { search: true } },
    });
    const picked = await selector.select(TENANT, 'CATALOG');
    expect(picked).toBeDefined();
  });

  it('LEAD_SINK needs createLead, ACTIONS needs the named operation', async () => {
    const { selector } = setup({
      rows: [row('a')],
      caps: { a: { createLead: true, createBooking: false } },
    });
    expect(await selector.select(TENANT, 'LEAD_SINK')).toBeDefined();
    expect(
      await selector.select(TENANT, 'ACTIONS', 'createLead'),
    ).toBeDefined();
    expect(
      await selector.select(TENANT, 'ACTIONS', 'createBooking'),
    ).toBeUndefined();
    expect(await selector.select(TENANT, 'CATALOG')).toBeUndefined();
  });

  it('a capability flag without the method does not qualify a write role', async () => {
    const prisma = {
      tenantConnectorRole: { findFirst: vi.fn(() => Promise.resolve(null)) },
      tenantConnector: { findMany: vi.fn(() => Promise.resolve([row('a')])) },
    } as unknown as PrismaService;
    const flagOnly = {
      capabilities: { createLead: true },
    } as unknown as CrmConnector;
    const loader = {
      create: vi.fn(() => Promise.resolve(flagOnly)),
    } as unknown as TenantConnectorLoader;
    const selector = new ConnectorSelector(prisma, loader);
    expect(await selector.select(TENANT, 'LEAD_SINK')).toBeUndefined();
  });

  it('a binding of another role does not affect this one', async () => {
    const { selector } = setup({
      bound: { role: 'LEAD_SINK', connector: row('b', { status: 'DISABLED' }) },
      rows: [row('a')],
      caps: { a: { search: true } },
    });
    expect(await selector.select(TENANT, 'CATALOG')).toBeDefined();
  });
});
