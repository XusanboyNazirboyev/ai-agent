import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConnectorError,
  ConnectorErrorCategory,
  writeExecutionOf,
} from '../interfaces/errors.js';
import { EnvSecretResolver } from '../registry/secret-resolver.js';
import {
  json,
  startHttpServer,
  type LocalServer,
  type TestHandler,
} from '../testing/local-http.js';
import { GenericRestConnector } from './generic-rest-connector.js';
import { RestHttpClient } from './http-client.js';
import { parseGenericRestConnectorConfig } from './rest-config.js';

const servers: LocalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function crm(handler: TestHandler): Promise<LocalServer> {
  const server = await startHttpServer(handler);
  servers.push(server);
  return server;
}

function rest(
  port: number,
  config: Record<string, unknown>,
): GenericRestConnector {
  return new GenericRestConnector(
    { tenantId: 'tenant-a', connectorKey: 'generic-rest' },
    {
      baseUrl: `http://crm.test:${port}/api`,
      auth: { type: 'bearer', secretRef: 'env:CONNECTOR_SECRET_TEST' },
      timeoutMs: 300,
      ...config,
    },
    {
      httpClient: new RestHttpClient({
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
        exemptLoopbackAddresses: ['127.0.0.1'],
      }),
      resolveSecret: new EnvSecretResolver({
        CONNECTOR_SECRET_TEST: 'fictional-token',
      }),
      sleep: async () => undefined,
    },
  );
}

const lead = {
  contact: { name: 'Fictional' },
  summary: 'Fictional lead',
  slots: {},
  reasonCodes: [],
};
const KEY = 'createLead:lead:01a16d05-e75b-70a0-9368-55c28be06da8';
const createLead = { method: 'POST', path: '/leads', itemPath: 'lead' };

describe('generic REST write idempotency', () => {
  it('defaults to none and sends no idempotency data', async () => {
    const server = await crm((_q, r) => json(r, 201, { lead: { id: 'L1' } }));
    const connector = rest(server.port, { endpoints: { createLead } });
    expect(connector.writeIdempotency).toBe('none');
    expect(connector.findLeadByIdempotencyKey).toBeUndefined();
    await connector.createLead?.(lead, { idempotencyKey: KEY });
    expect(server.requests[0].headers['idempotency-key']).toBeUndefined();
    expect(server.requests[0].body).not.toContain(KEY);
  });

  it('native: sends the same key in the configured header on every attempt', async () => {
    const server = await crm((_q, r) => json(r, 201, { lead: { id: 'L1' } }));
    const connector = rest(server.port, {
      endpoints: { createLead },
      writeIdempotency: { mode: 'native', header: 'Idempotency-Key' },
    });
    expect(connector.writeIdempotency).toBe('native');
    await connector.createLead?.(lead, { idempotencyKey: KEY });
    await connector.createLead?.(lead, { idempotencyKey: KEY });
    expect(server.requests.map((q) => q.headers['idempotency-key'])).toEqual([
      KEY,
      KEY,
    ]);
    // The auth header is not displaced by the idempotency header.
    expect(server.requests[0].headers.authorization).toBe(
      'Bearer fictional-token',
    );
  });

  it('refuses a malformed key before sending anything', async () => {
    const server = await crm((_q, r) => json(r, 201, { lead: { id: 'L1' } }));
    const connector = rest(server.port, {
      endpoints: { createLead },
      writeIdempotency: { mode: 'native', header: 'Idempotency-Key' },
    });
    const error = await connector
      .createLead?.(lead, { idempotencyKey: 'bad key\r\nX: y' })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      category: ConnectorErrorCategory.VALIDATION,
    });
    expect(writeExecutionOf(error)).toBe('NOT_EXECUTED');
    expect(server.requests).toHaveLength(0);
  });

  it('lookup: stores the key on the record and finds it again; 404 or empty means not created', async () => {
    const created = new Map<string, string>();
    const server = await crm((request, response) => {
      if (request.method === 'POST') {
        const body = JSON.parse(request.bodyText) as { meta: { ref: string } };
        created.set(body.meta.ref, 'L9');
        return json(response, 201, { lead: { id: 'L9' } });
      }
      const ref =
        new URL(request.url ?? '', 'http://x').searchParams.get('ref') ?? '';
      if (ref === 'createLead:lead:missing-404') return json(response, 404, {});
      const id = created.get(ref);
      return json(response, 200, { data: id ? [{ id }] : [] });
    });
    const connector = rest(server.port, {
      endpoints: { createLead, findLeadByReference: { path: '/leads' } },
      writeIdempotency: {
        mode: 'lookup',
        referenceField: 'meta.ref',
        referenceQueryParam: 'ref',
      },
    });
    expect(connector.writeIdempotency).toBe('lookup');
    expect(await connector.findLeadByIdempotencyKey?.(KEY)).toBeUndefined();
    await connector.createLead?.(lead, { idempotencyKey: KEY });
    expect(await connector.findLeadByIdempotencyKey?.(KEY)).toEqual({
      crmLeadId: 'L9',
    });
    expect(
      await connector.findLeadByIdempotencyKey?.('createLead:lead:missing-404'),
    ).toBeUndefined();
    // Without a key the record could never be found again: refused, nothing sent.
    const before = server.requests.length;
    await expect(connector.createLead?.(lead)).rejects.toMatchObject({
      category: ConnectorErrorCategory.VALIDATION,
    });
    expect(server.requests).toHaveLength(before);
  });

  it('lookup: several records for one reference is an error, never a guess', async () => {
    const server = await crm((_q, r) =>
      json(r, 200, { data: [{ id: 'A' }, { id: 'B' }] }),
    );
    const connector = rest(server.port, {
      endpoints: { createLead, findLeadByReference: { path: '/leads' } },
      writeIdempotency: {
        mode: 'lookup',
        referenceField: 'ref',
        referenceQueryParam: 'ref',
      },
    });
    await expect(
      connector.findLeadByIdempotencyKey?.(KEY),
    ).rejects.toMatchObject({
      code: 'CONNECTOR_AMBIGUOUS_LOOKUP',
    });
  });

  it('rejects configurations that cannot keep their promise', () => {
    const base = {
      baseUrl: 'https://crm.example/api',
      endpoints: { createLead },
    };
    expect(() =>
      parseGenericRestConnectorConfig({
        ...base,
        writeIdempotency: { mode: 'lookup', referenceField: 'ref' },
      }),
    ).toThrow(/findLeadByReference/u);
    expect(() =>
      parseGenericRestConnectorConfig({
        ...base,
        endpoints: { createLead, findLeadByReference: { path: '/leads' } },
        writeIdempotency: { mode: 'lookup', referenceField: 'ref' },
      }),
    ).toThrow(/referenceQueryParam/u);
    expect(() =>
      parseGenericRestConnectorConfig({
        ...base,
        auth: {
          type: 'apiKey',
          secretRef: 'env:CONNECTOR_SECRET_X',
          headerName: 'X-Key',
        },
        writeIdempotency: { mode: 'native', header: 'x-key' },
      }),
    ).toThrow(/authentication header/u);
    expect(() =>
      parseGenericRestConnectorConfig({
        baseUrl: 'https://crm.example/api',
        writeIdempotency: { mode: 'native', header: 'Idempotency-Key' },
      }),
    ).toThrow(/createLead/u);
  });
});

describe('write outcome classification over real HTTP', () => {
  const outcome = async (handler: TestHandler): Promise<unknown> => {
    const server = await crm(handler);
    return rest(server.port, { endpoints: { createLead } })
      .createLead?.(lead, { idempotencyKey: KEY })
      .catch((e: unknown) => e);
  };

  it('treats explicit rejections as not executed', async () => {
    for (const status of [400, 401, 403, 422, 429]) {
      const error = await outcome((_q, r) => json(r, status, {}));
      expect(writeExecutionOf(error), String(status)).toBe('NOT_EXECUTED');
    }
  });

  it('treats 409, 5xx, timeouts and unreadable success as uncertain', async () => {
    for (const status of [409, 500, 502, 503]) {
      const error = await outcome((_q, r) => json(r, status, {}));
      expect(writeExecutionOf(error), String(status)).toBe('UNCERTAIN');
    }
    const slow = await outcome((_q, r) => {
      setTimeout(() => json(r, 201, { lead: { id: 'late' } }), 1_000);
    });
    expect(slow).toMatchObject({ category: ConnectorErrorCategory.TIMEOUT });
    expect(writeExecutionOf(slow)).toBe('UNCERTAIN');
    const noId = await outcome((_q, r) => json(r, 201, { lead: {} }));
    expect(writeExecutionOf(noId)).toBe('UNCERTAIN');
  });

  it('treats a refused connection as not executed', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address() as { port: number };
        probe.close(() => resolve(free));
      });
    });
    const error = await rest(port, { endpoints: { createLead } })
      .createLead?.(lead, { idempotencyKey: KEY })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(writeExecutionOf(error)).toBe('NOT_EXECUTED');
  });

  it('treats anything that is not a connector error as uncertain', () => {
    expect(writeExecutionOf(new Error('boom'))).toBe('UNCERTAIN');
    expect(writeExecutionOf(undefined)).toBe('UNCERTAIN');
  });
});
