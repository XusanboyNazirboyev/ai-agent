import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorErrorCategory } from '../interfaces/errors.js';
import { EnvSecretResolver } from '../registry/secret-resolver.js';
import {
  json,
  startHttpServer,
  type LocalServer,
  type TestHandler,
} from '../testing/local-http.js';
import {
  GenericRestConnector,
  type GenericRestConnectorOptions,
} from './generic-rest-connector.js';
import { RestHttpClient } from './http-client.js';

const TOKEN = 'fictional-token-value';
const servers: LocalServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function crm(handler: TestHandler): Promise<LocalServer> {
  const server = await startHttpServer(handler);
  servers.push(server);
  return server;
}

function connector(
  server: LocalServer,
  config: Record<string, unknown>,
  options: Partial<GenericRestConnectorOptions> & { tenantId?: string } = {},
): GenericRestConnector {
  return new GenericRestConnector(
    { tenantId: options.tenantId ?? 'tenant-a', connectorKey: 'generic-rest' },
    {
      baseUrl: `http://crm.test:${server.port}/api`,
      auth: { type: 'bearer', secretRef: 'env:CONNECTOR_SECRET_TEST' },
      ...config,
    },
    {
      httpClient: new RestHttpClient({
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
        exemptLoopbackAddresses: ['127.0.0.1'],
      }),
      resolveSecret: new EnvSecretResolver({ CONNECTOR_SECRET_TEST: TOKEN }),
      sleep: async () => undefined,
      ...options,
    },
  );
}

const items = (count: number): Array<{ id: string; title: string }> =>
  Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    title: `Fictional item ${index}`,
  }));

describe('GenericRestConnector request construction', () => {
  it('URL-encodes identifiers so they cannot address other endpoints', async () => {
    const server = await crm((request, response) =>
      json(response, 200, { id: 'a/../../admin', title: 'Fictional' }),
    );
    const rest = connector(server, {
      endpoints: { getItem: { path: '/items/{sourceEntityId}' } },
    });

    await rest.getItem?.('generic-rest:a/../../admin');
    expect(server.requests[0].url).toBe('/api/items/a%2F..%2F..%2Fadmin');

    for (const id of ['..', 'generic-rest:..', 'other-system:item-1']) {
      await expect(rest.getItem?.(id)).rejects.toMatchObject({
        code: 'CONNECTOR_INVALID_ID',
        category: ConnectorErrorCategory.VALIDATION,
      });
    }
    expect(server.requests).toHaveLength(1);
  });

  it('sends the bare upstream offer id for canonical offer ids', async () => {
    const server = await crm((_request, response) =>
      json(response, 200, { status: 'available', seatsLeft: 3 }),
    );
    const rest = connector(server, {
      endpoints: {
        checkAvailability: { method: 'POST', path: '/offers/{offerId}/check' },
      },
    });

    await expect(
      rest.checkAvailability?.('generic-rest:offer:o-7', {
        offerId: 'generic-rest:offer:o-7',
      }),
    ).resolves.toEqual({
      offerId: 'generic-rest:offer:o-7',
      status: 'AVAILABLE',
      seatsLeft: 3,
    });
    expect(server.requests[0].url).toBe('/api/offers/o-7/check');
  });

  it('never lets caller attributes override identity or configured fields', async () => {
    const server = await crm((_request, response) =>
      json(response, 200, { amount: '10.00', currency: 'USD' }),
    );
    const rest = connector(server, {
      endpoints: {
        getQuote: {
          method: 'POST',
          path: '/offers/{offerId}/quote',
          body: { agencyId: 'configured-agency' },
        },
      },
    });

    await rest.getQuote?.('generic-rest:offer:o-1', {
      offerId: 'generic-rest:offer:o-1',
      attributes: { offerId: 'o-999', agencyId: 'attacker', adults: 2 },
    });
    expect(JSON.parse(server.requests[0].body)).toEqual({
      offerId: 'o-1',
      agencyId: 'configured-agency',
      adults: 2,
    });
  });

  it('rejects a request whose offer id disagrees with the argument', async () => {
    const server = await crm((_request, response) => json(response, 200, {}));
    const rest = connector(server, {
      endpoints: { getQuote: { method: 'POST', path: '/q/{offerId}' } },
    });
    await expect(
      rest.getQuote?.('generic-rest:offer:o-1', {
        offerId: 'generic-rest:offer:o-2',
      }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_INVALID_INPUT' });
    expect(server.requests).toHaveLength(0);
  });

  it('sends only the supplied fields in a lead patch', async () => {
    const server = await crm((_request, response) => {
      response.writeHead(204).end();
    });
    const rest = connector(server, {
      endpoints: {
        updateLead: { method: 'PATCH', path: '/leads/{crmLeadId}' },
      },
    });

    await rest.updateLead?.('lead/7', { summary: 'Updated fictional lead' });
    expect(server.requests[0].url).toBe('/api/leads/lead%2F7');
    expect(JSON.parse(server.requests[0].body)).toEqual({
      summary: 'Updated fictional lead',
    });
  });

  it('presents only configured operations', () => {
    const rest = new GenericRestConnector(
      { tenantId: 'tenant-a', connectorKey: 'generic-rest' },
      {
        baseUrl: 'https://crm.example.com',
        endpoints: { getItem: { path: '/items/{sourceEntityId}' } },
      },
    );
    expect(typeof rest.getItem).toBe('function');
    expect(rest.searchItems).toBeUndefined();
    expect(rest.listItems).toBeUndefined();
    expect(rest.createLead).toBeUndefined();
    expect(rest.capabilities.search).toBe(false);
  });

  it('refuses a base URL the STRICT policy can never reach', () => {
    expect(
      () =>
        new GenericRestConnector(
          { tenantId: 'tenant-a', connectorKey: 'generic-rest' },
          { baseUrl: 'http://169.254.169.254/latest' },
        ),
    ).toThrow(expect.objectContaining({ code: 'CONNECTOR_SSRF_BLOCKED_HOST' }));
  });
});

describe('GenericRestConnector response mapping', () => {
  it('rejects a record that is a different item than requested', async () => {
    const server = await crm((_request, response) =>
      json(response, 200, { id: 'item-2', title: 'Fictional' }),
    );
    const rest = connector(server, {
      endpoints: { getItem: { path: '/items/{sourceEntityId}' } },
    });
    await expect(rest.getItem?.('generic-rest:item-1')).rejects.toMatchObject({
      code: 'CONNECTOR_IDENTITY_MISMATCH',
    });
  });

  it('rejects offers linked to another item', async () => {
    const server = await crm((_request, response) =>
      json(response, 200, { data: [{ id: 'o-1', item: 'item-2' }] }),
    );
    const rest = connector(server, {
      endpoints: { getOffers: { path: '/items/{itemId}/offers' } },
      fieldMappings: { offer: { itemId: 'item' } },
    });
    await expect(rest.getOffers?.('generic-rest:item-1')).rejects.toMatchObject(
      {
        code: 'CONNECTOR_IDENTITY_MISMATCH',
      },
    );
  });

  it('links unmapped offers to the requested item and maps exact prices', async () => {
    const server = await crm((_request, response) =>
      json(response, 200, {
        data: [
          {
            id: 'o-1',
            price: { amount: '1200.50', currency: 'usd' },
            availabilityStatus: 'limited',
            seatsLeft: 2,
          },
          { id: 'o-2' },
        ],
      }),
    );
    const rest = connector(server, {
      endpoints: { getOffers: { path: '/items/{itemId}/offers' } },
    });
    await expect(rest.getOffers?.('generic-rest:item-1')).resolves.toEqual([
      {
        id: 'generic-rest:offer:o-1',
        itemId: 'generic-rest:item-1',
        sourceSystem: 'generic-rest',
        sourceEntityId: 'o-1',
        price: { amount: '1200.50', currency: 'USD' },
        currency: 'USD',
        pricingBasis: 'UNSPECIFIED',
        availabilityStatus: 'LIMITED',
        seatsLeft: 2,
        attributes: {},
      },
      {
        id: 'generic-rest:offer:o-2',
        itemId: 'generic-rest:item-1',
        sourceSystem: 'generic-rest',
        sourceEntityId: 'o-2',
        price: null,
        pricingBasis: 'UNSPECIFIED',
        availabilityStatus: 'UNKNOWN',
        attributes: {},
      },
    ]);
  });

  it.each([
    [
      { data: [{ id: 'x', title: { en: 'object' } }] },
      'CONNECTOR_INVALID_FIELD',
    ],
    [{ data: [{ title: 'no id' }] }, 'CONNECTOR_INVALID_FIELD'],
    [{ data: { not: 'a list' } }, 'CONNECTOR_INVALID_LIST_SHAPE'],
    [{ results: [] }, 'CONNECTOR_INVALID_LIST_SHAPE'],
  ])('rejects malformed list response %o', async (body, code) => {
    const server = await crm((_request, response) => json(response, 200, body));
    const rest = connector(server, {
      endpoints: { listItems: { path: '/items' } },
    });
    await expect(rest.listItems?.()).rejects.toMatchObject({
      code,
      category: ConnectorErrorCategory.INVALID_RESPONSE,
    });
  });

  it('labels items with the configured type and ignores caller relabelling', async () => {
    const server = await crm((_request, response) =>
      json(response, 200, { data: items(1) }),
    );
    const rest = connector(server, {
      catalogItemType: 'course',
      endpoints: { listItems: { path: '/items' } },
    });
    await expect(rest.listItems?.()).resolves.toMatchObject([
      { itemType: 'course' },
    ]);
    await expect(rest.listItems?.({ itemType: 'tour' })).resolves.toEqual([]);
    expect(server.requests).toHaveLength(1);
  });
});

describe('GenericRestConnector search', () => {
  it('sends only configured filter parameters', async () => {
    const server = await crm((_request, response) =>
      json(response, 200, { data: items(3) }),
    );
    const rest = connector(server, {
      endpoints: {
        searchItems: {
          path: '/search',
          searchParams: { title: 'name', attributes: { level: 'lvl' } },
          pagination: { strategy: 'offset', limitParam: 'take', pageSize: 10 },
        },
      },
    });

    await expect(
      rest.searchItems?.({
        title: 'Fictional',
        attributes: { level: 'B1' },
        limit: 2,
      }),
    ).resolves.toHaveLength(2);
    const url = new URL(server.requests[0].url, 'http://x');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      name: 'Fictional',
      lvl: 'B1',
      take: '2',
    });
  });

  it.each([
    [{ attributes: { colour: 'red' } }],
    [{ attributes: { level: { nested: true } } }],
    [{ title: 'x', offset: 5 }],
  ])('refuses to silently drop filter %o', async (query) => {
    const server = await crm((_request, response) =>
      json(response, 200, { data: [] }),
    );
    const rest = connector(server, {
      endpoints: {
        searchItems: {
          path: '/search',
          searchParams: { title: 'name', attributes: { level: 'lvl' } },
        },
      },
    });
    await expect(rest.searchItems?.(query)).rejects.toMatchObject({
      code: 'CONNECTOR_UNSUPPORTED_FILTER',
      category: ConnectorErrorCategory.VALIDATION,
    });
    expect(server.requests).toHaveLength(0);
  });
});

describe('GenericRestConnector pagination', () => {
  it('walks offset pages until a short page', async () => {
    const all = items(5);
    const server = await crm((request, response) => {
      const url = new URL(request.url ?? '/', 'http://x');
      const skip = Number(url.searchParams.get('skip'));
      const limit = Number(url.searchParams.get('limit'));
      json(response, 200, { data: all.slice(skip, skip + limit) });
    });
    const rest = connector(server, {
      endpoints: {
        listItems: {
          path: '/items',
          pagination: { strategy: 'offset', offsetParam: 'skip', pageSize: 2 },
        },
      },
    });

    const listed = (await rest.listItems?.()) ?? [];
    expect(listed.map((item) => item.sourceEntityId)).toEqual(
      all.map((item) => item.id),
    );
    expect(server.requests.map((request) => request.url)).toEqual([
      '/api/items?limit=2&skip=0',
      '/api/items?limit=2&skip=2',
      '/api/items?limit=2&skip=4',
    ]);
  });

  it('never requests more than the remaining limit', async () => {
    const all = items(10);
    const server = await crm((request, response) => {
      const url = new URL(request.url ?? '/', 'http://x');
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      json(response, 200, { data: all.slice(offset, offset + limit) });
    });
    const rest = connector(server, {
      endpoints: {
        listItems: {
          path: '/items',
          pagination: { strategy: 'offset', pageSize: 2 },
        },
      },
    });
    await expect(rest.listItems?.({ limit: 3 })).resolves.toHaveLength(3);
    expect(server.requests.map((request) => request.url)).toEqual([
      '/api/items?limit=2&offset=0',
      '/api/items?limit=1&offset=2',
    ]);
  });

  it('follows cursors and stops when none is returned', async () => {
    const pages: Record<string, { data: unknown[]; next?: string }> = {
      start: { data: items(2), next: 'c2' },
      c2: { data: [{ id: 'item-9', title: 'Fictional item 9' }] },
    };
    const server = await crm((request, response) => {
      const cursor =
        new URL(request.url ?? '/', 'http://x').searchParams.get('after') ??
        'start';
      json(response, 200, {
        data: pages[cursor].data,
        paging: { next: pages[cursor].next },
      });
    });
    const rest = connector(server, {
      endpoints: {
        listItems: {
          path: '/items',
          pagination: {
            strategy: 'cursor',
            cursorParam: 'after',
            cursorPath: 'paging.next',
          },
        },
      },
    });

    await expect(rest.listItems?.()).resolves.toHaveLength(3);
    expect(server.requests).toHaveLength(2);
  });

  it('makes exactly one request when pagination is disabled', async () => {
    const server = await crm((_request, response) =>
      json(response, 200, { data: items(3) }),
    );
    const rest = connector(server, {
      endpoints: { listItems: { path: '/items' } },
    });
    await expect(rest.listItems?.()).resolves.toHaveLength(3);
    expect(server.requests).toHaveLength(1);
  });

  it('drops duplicates from overlapping pages without counting them', async () => {
    // Page 2 repeats item-1 (e.g. an insert shifted the upstream offsets).
    const pages = [[items(2)[0], items(2)[1]], [items(3)[1], items(3)[2]], []];
    let page = 0;
    const server = await crm((_request, response) =>
      json(response, 200, { data: pages[page++] ?? [] }),
    );
    const rest = connector(server, {
      endpoints: {
        listItems: {
          path: '/items',
          pagination: { strategy: 'offset', pageSize: 2 },
        },
      },
    });
    const listed = (await rest.listItems?.({ limit: 3 })) ?? [];
    expect(listed.map((item) => item.sourceEntityId)).toEqual([
      'item-0',
      'item-1',
      'item-2',
    ]);
  });

  it('fails instead of returning a truncated catalog at maxPages', async () => {
    const server = await crm((_request, response) =>
      json(response, 200, { data: items(2) }),
    );
    const rest = connector(server, {
      endpoints: {
        listItems: {
          path: '/items',
          pagination: { strategy: 'offset', pageSize: 2, maxPages: 3 },
        },
      },
    });
    await expect(rest.listItems?.()).rejects.toMatchObject({
      code: 'CONNECTOR_PAGINATION_LIMIT_REACHED',
    });
    expect(server.requests).toHaveLength(3);
  });

  it('refuses to loop on a repeated cursor', async () => {
    const server = await crm((_request, response) =>
      json(response, 200, { data: items(1), nextCursor: 'same' }),
    );
    const rest = connector(server, {
      endpoints: {
        listItems: { path: '/items', pagination: { strategy: 'cursor' } },
      },
    });
    await expect(rest.listItems?.()).rejects.toMatchObject({
      code: 'CONNECTOR_PAGINATION_LOOP',
    });
  });
});

describe('GenericRestConnector resilience', () => {
  function flaky(failures: number, status = 503): TestHandler {
    let calls = 0;
    return (_request, response) => {
      calls++;
      if (calls <= failures) {
        json(response, status, { error: 'fictional outage' });
      } else {
        json(response, 200, { data: items(1), lead: { id: 'lead-1' } });
      }
    };
  }

  it('retries transient read failures', async () => {
    const server = await crm(flaky(2));
    const rest = connector(server, {
      maxRetries: 3,
      endpoints: { listItems: { path: '/items' } },
    });
    await expect(rest.listItems?.()).resolves.toHaveLength(1);
    expect(server.requests).toHaveLength(3);
  });

  it('never retries writes, even on a transient failure', async () => {
    const server = await crm(flaky(1));
    const rest = connector(server, {
      maxRetries: 3,
      endpoints: {
        createLead: { method: 'POST', path: '/leads', itemPath: 'lead' },
      },
    });
    await expect(
      rest.createLead?.({
        contact: {},
        summary: 'Fictional lead',
        slots: {},
        reasonCodes: [],
      }),
    ).rejects.toMatchObject({
      code: 'CONNECTOR_UPSTREAM_ERROR',
      retryable: true,
    });
    expect(server.requests).toHaveLength(1);
  });

  it('does not retry earlier than an upstream Retry-After allows', async () => {
    const server = await crm((_request, response) =>
      json(response, 429, {}, { 'retry-after': '120' }),
    );
    const rest = connector(server, {
      maxRetries: 3,
      retryMaxMs: 5_000,
      endpoints: { listItems: { path: '/items' } },
    });
    await expect(rest.listItems?.()).rejects.toMatchObject({
      code: 'CONNECTOR_RATE_LIMITED',
      retryAfterMs: 120_000,
    });
    expect(server.requests).toHaveLength(1);
  });

  it('does not retry permanent errors', async () => {
    const server = await crm(flaky(5, 400));
    const rest = connector(server, {
      maxRetries: 3,
      endpoints: { listItems: { path: '/items' } },
    });
    await expect(rest.listItems?.()).rejects.toMatchObject({
      code: 'CONNECTOR_REQUEST_FAILED',
    });
    expect(server.requests).toHaveLength(1);
  });

  it('opens the circuit on transient failures, per tenant', async () => {
    const server = await crm((_request, response) => json(response, 503, {}));
    const config = {
      maxRetries: 0,
      circuitBreaker: { failureThreshold: 2, recoveryIntervalMs: 60_000 },
      endpoints: { listItems: { path: '/items' } },
    };
    const tenantA = connector(server, config, { tenantId: 'tenant-a' });
    const tenantB = connector(server, config, { tenantId: 'tenant-b' });

    await expect(tenantA.listItems?.()).rejects.toMatchObject({
      code: 'CONNECTOR_UPSTREAM_ERROR',
    });
    await expect(tenantA.listItems?.()).rejects.toMatchObject({
      code: 'CONNECTOR_UPSTREAM_ERROR',
    });
    await expect(tenantA.listItems?.()).rejects.toMatchObject({
      code: 'CONNECTOR_CIRCUIT_OPEN',
    });
    expect(server.requests).toHaveLength(2);

    // Tenant B's breaker is independent.
    await expect(tenantB.listItems?.()).rejects.toMatchObject({
      code: 'CONNECTOR_UPSTREAM_ERROR',
    });
    expect(server.requests).toHaveLength(3);
  });

  it('does not open the circuit on not-found answers', async () => {
    const server = await crm((_request, response) => json(response, 404, {}));
    const rest = connector(server, {
      circuitBreaker: { failureThreshold: 1 },
      endpoints: { getItem: { path: '/items/{sourceEntityId}' } },
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        rest.getItem?.('generic-rest:missing'),
      ).rejects.toMatchObject({
        code: 'CONNECTOR_NOT_FOUND',
      });
    }
    expect(server.requests).toHaveLength(3);
  });
});

describe('GenericRestConnector credentials', () => {
  it.each([
    [
      { type: 'bearer', secretRef: 'env:CONNECTOR_SECRET_TEST' },
      'authorization',
      `Bearer ${TOKEN}`,
    ],
    [
      {
        type: 'apiKey',
        secretRef: 'env:CONNECTOR_SECRET_TEST',
        headerName: 'X-Api-Key',
      },
      'x-api-key',
      TOKEN,
    ],
    [
      {
        type: 'basic',
        usernameRef: 'env:CONNECTOR_SECRET_TEST',
        passwordRef: 'env:CONNECTOR_SECRET_TEST',
      },
      'authorization',
      `Basic ${Buffer.from(`${TOKEN}:${TOKEN}`).toString('base64')}`,
    ],
  ])('sends %o credentials', async (auth, header, value) => {
    const server = await crm((_request, response) =>
      json(response, 200, { data: [] }),
    );
    const rest = connector(server, {
      auth,
      endpoints: { listItems: { path: '/items' } },
    });
    await rest.listItems?.();
    expect(server.requests[0].headers[header]).toBe(value);
  });

  it('fails closed before any request when a secret does not resolve', async () => {
    const server = await crm((_request, response) =>
      json(response, 200, { data: [] }),
    );
    const rest = connector(
      server,
      {
        auth: { type: 'bearer', secretRef: 'env:POSTGRES_PASSWORD' },
        endpoints: { listItems: { path: '/items' } },
      },
      {
        // A platform secret is present in the environment but outside the
        // connector namespace, so it must never be sent to a tenant URL.
        resolveSecret: new EnvSecretResolver({
          POSTGRES_PASSWORD: 'platform-db-password',
        }),
      },
    );
    await expect(rest.initialize()).rejects.toMatchObject({
      code: 'CONNECTOR_SECRET_UNRESOLVED',
    });
    await expect(rest.listItems?.()).rejects.toMatchObject({
      code: 'CONNECTOR_SECRET_UNRESOLVED',
    });
    expect(server.requests).toHaveLength(0);
  });

  it('keeps tokens out of upstream error messages', async () => {
    const server = await crm((_request, response) =>
      json(response, 401, { message: `bad token ${TOKEN}` }),
    );
    const rest = connector(server, {
      endpoints: { listItems: { path: '/items' } },
    });
    const error = await rest
      .listItems?.()
      .catch((rejection: unknown) => rejection);
    expect(error).toMatchObject({
      code: 'CONNECTOR_UNAUTHORIZED',
      category: ConnectorErrorCategory.AUTHENTICATION,
    });
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });
});

describe('GenericRestConnector outbound write mapping', () => {
  const lead = {
    contact: { name: 'Fictional Customer', phone: '+000 0000' },
    summary: 'Fictional lead summary',
    slots: { level: 'B1' },
    score: 'WARM' as const,
    reasonCodes: ['PHONE_PROVIDED'],
  };

  function leadConnector(
    server: LocalServer,
    requestBody: unknown,
  ): GenericRestConnector {
    return connector(server, {
      endpoints: {
        createLead: {
          method: 'POST',
          path: '/leads',
          requestBody,
        },
        updateLead: {
          method: 'PATCH',
          path: '/leads/{crmLeadId}',
          requestBody,
        },
      },
    });
  }

  it('sends only the mapped native fields, nested as configured', async () => {
    const server = await crm((_request, response) =>
      json(response, 201, { id: 'lead-1' }),
    );
    const rest = leadConnector(server, {
      'customer.full_name': { from: 'contact.name', required: true },
      'customer.mobile': { from: 'contact.phone' },
      'meta.english_level': { from: 'slots.level' },
      'meta.channel': { value: 'telegram-bot' },
    });

    await expect(rest.createLead?.(lead)).resolves.toEqual({
      crmLeadId: 'lead-1',
    });
    expect(JSON.parse(server.requests[0].body)).toEqual({
      customer: { full_name: 'Fictional Customer', mobile: '+000 0000' },
      meta: { english_level: 'B1', channel: 'telegram-bot' },
    });
  });

  it('omits a missing optional source instead of inventing a value', async () => {
    const server = await crm((_request, response) =>
      json(response, 201, { id: 'lead-1' }),
    );
    const rest = leadConnector(server, {
      name: { from: 'contact.name', required: true },
      phone: { from: 'contact.phone' },
    });
    await rest.createLead?.({
      ...lead,
      contact: { name: 'Fictional Customer' },
    });
    expect(JSON.parse(server.requests[0].body)).toEqual({
      name: 'Fictional Customer',
    });
  });

  it('rejects a missing required field before any external write', async () => {
    const server = await crm((_request, response) =>
      json(response, 201, { id: 'lead-1' }),
    );
    const rest = leadConnector(server, {
      phone: { from: 'contact.phone', required: true },
    });
    await expect(
      rest.createLead?.({ ...lead, contact: { name: 'No phone' } }),
    ).rejects.toMatchObject({
      code: 'CONNECTOR_INVALID_INPUT',
      category: ConnectorErrorCategory.VALIDATION,
    });
    expect(server.requests).toHaveLength(0);
  });

  it('maps patches field by field and refuses an empty mapped patch', async () => {
    const server = await crm((_request, response) => {
      response.writeHead(204).end();
    });
    const rest = leadConnector(server, {
      name: { from: 'contact.name', required: true },
      note: { from: 'summary' },
    });

    await rest.updateLead?.('lead-1', { summary: 'Updated fictional summary' });
    expect(JSON.parse(server.requests[0].body)).toEqual({
      note: 'Updated fictional summary',
    });
    await expect(
      rest.updateLead?.('lead-1', { score: 'HOT' }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_INVALID_INPUT' });
    expect(server.requests).toHaveLength(1);
  });

  it('maps bookings using the upstream offer id', async () => {
    const server = await crm((_request, response) =>
      json(response, 201, { id: 'booking-1' }),
    );
    const rest = connector(server, {
      endpoints: {
        createBooking: {
          method: 'POST',
          path: '/bookings',
          requestBody: {
            group_id: { from: 'offerId', required: true },
            student: { from: 'contact.name' },
            preferred_time: { from: 'details.preferredTime' },
          },
        },
      },
    });
    await rest.createBooking?.({
      offerId: 'generic-rest:offer:g-7',
      contact: { name: 'Fictional Student' },
      details: { preferredTime: 'evening', internalNote: 'not mapped' },
    });
    expect(JSON.parse(server.requests[0].body)).toEqual({
      group_id: 'g-7',
      student: 'Fictional Student',
      preferred_time: 'evening',
    });
  });
});
