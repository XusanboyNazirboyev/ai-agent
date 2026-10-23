import { describe, expect, it } from 'vitest';
import { RecordReader } from './field-mapping.js';
import {
  deriveCapabilities,
  getByPath,
  parseGenericRestConnectorConfig,
} from './rest-config.js';

const base = { baseUrl: 'https://crm.example.com/api' };

function rejects(config: Record<string, unknown>): string {
  try {
    parseGenericRestConnectorConfig(config);
  } catch (error) {
    expect(error).toMatchObject({ code: 'CONNECTOR_INVALID_CONFIG' });
    return (error as Error).message;
  }
  throw new Error('expected the configuration to be rejected');
}

describe('GenericRestConnector configuration', () => {
  it('applies restrictive defaults', () => {
    const config = parseGenericRestConnectorConfig(base);
    expect(config).toMatchObject({
      auth: { type: 'none' },
      catalogItemType: 'item',
      maxRedirects: 0,
      maxResponseBytes: 5 * 1024 * 1024,
      fieldMappings: {},
      endpoints: {},
    });
  });

  it('does not let tenant configuration select the outbound policy', () => {
    rejects({ ...base, outboundUrlPolicy: 'permissive' });
  });

  it.each([
    [{ baseUrl: 'ftp://crm.example.com' }],
    [{ baseUrl: 'https://crm.example.com/api?token=1' }],
    [{ baseUrl: 'https://crm.example.com/#x' }],
  ])('rejects base URL %o', (config) => {
    rejects(config);
  });

  it('rejects embedded credentials without echoing them', () => {
    const message = rejects({
      baseUrl: 'https://user:hunter2-secret@crm.example.com/',
    });
    expect(message).not.toContain('hunter2-secret');
  });

  it.each([
    [{ type: 'bearer' }],
    [{ type: 'apiKey', secretRef: 'env:CONNECTOR_SECRET_X' }],
    [
      {
        type: 'apiKey',
        secretRef: 'env:CONNECTOR_SECRET_X',
        headerName: 'Host',
      },
    ],
    [
      {
        type: 'apiKey',
        secretRef: 'env:CONNECTOR_SECRET_X',
        headerName: 'bad header',
      },
    ],
    [{ type: 'basic', usernameRef: 'env:CONNECTOR_SECRET_U' }],
    [{ type: 'bearer', secretRef: 'plain-secret-value' }],
    [{ type: 'oauth', secretRef: 'env:CONNECTOR_SECRET_X' }],
  ])('rejects incomplete or unsafe auth %o', (auth) => {
    rejects({ ...base, auth });
  });

  it.each([
    ['__proto__.polluted'],
    ['constructor.name'],
    ['data.prototype'],
    ['data[0]'],
    ['a..b'],
  ])('rejects mapping path %s', (path) => {
    rejects({ ...base, fieldMappings: { item: { title: path } } });
  });

  it('rejects unknown mapping keys instead of ignoring them', () => {
    rejects({ ...base, fieldMappings: { item: { price: 'cost' } } });
    rejects({ ...base, fieldMappings: { product: { title: 'name' } } });
  });

  it.each([
    ['/items/{offerId}'],
    ['/items/{sourceEntityId}/../admin'],
    ['/items?debug=1'],
    ['/items#x'],
  ])('rejects getItem path %s', (path) => {
    rejects({ ...base, endpoints: { getItem: { path } } });
  });

  it('rejects a retry base delay above the maximum', () => {
    rejects({ ...base, retryBaseMs: 50_000, retryMaxMs: 1_000 });
  });

  it('advertises search only when the search endpoint exists', () => {
    const config = parseGenericRestConnectorConfig({
      ...base,
      endpoints: {
        getItem: { path: '/items/{sourceEntityId}' },
        getOffers: { path: '/items/{itemId}/offers' },
      },
    });
    expect(deriveCapabilities(config.endpoints)).toEqual({
      sync: false,
      search: false,
      liveQuote: false,
      availability: false,
      createLead: false,
      updateLead: false,
      createBooking: false,
      webhooks: false,
    });
  });
});

describe('getByPath', () => {
  const record = JSON.parse(
    '{"a":{"b":[{"c":1}]},"__proto__":{"x":1},"list":[10,20]}',
  ) as unknown;

  it('follows own properties and array indices', () => {
    expect(getByPath(record, 'a.b.0.c')).toBe(1);
    expect(getByPath(record, 'list.1')).toBe(20);
    expect(getByPath(record, '$')).toBe(record);
  });

  it('never reaches the prototype chain', () => {
    expect(getByPath({}, 'toString')).toBeUndefined();
    expect(getByPath({}, 'constructor')).toBeUndefined();
    expect(getByPath(record, '__proto__.x')).toBeUndefined();
    expect(getByPath(record, 'list.length')).toBeUndefined();
  });
});

describe('RecordReader', () => {
  const read = (record: unknown): RecordReader =>
    new RecordReader(record, 'item', 'test');

  it('reads identifiers from strings and safe integers only', () => {
    expect(read({ id: 42 }).identifier('id', ['id'])).toBe('42');
    expect(read({ id: ' a-1 ' }).identifier('id', ['id'])).toBe('a-1');
    for (const id of [{ nested: 1 }, 1.5, '', 'x'.repeat(201), 'a\nb', true]) {
      expect(() => read({ id }).identifier('id', ['id'])).toThrow(
        expect.objectContaining({ code: 'CONNECTOR_INVALID_FIELD' }),
      );
    }
  });

  it('never coerces a non-string title into text', () => {
    expect(() =>
      read({ title: { en: 'x' } }).text('title', ['title'], {
        required: true,
        max: 500,
      }),
    ).toThrow(expect.objectContaining({ code: 'CONNECTOR_INVALID_FIELD' }));
    expect(() =>
      read({}).text('title', ['title'], { required: true, max: 500 }),
    ).toThrow(expect.objectContaining({ code: 'CONNECTOR_INVALID_FIELD' }));
  });

  it('reads exact money or rejects it', () => {
    const money = (record: unknown): unknown =>
      read(record).money('price', ['amount'], ['currency']);
    expect(money({ amount: '150.00', currency: 'usd' })).toEqual({
      amount: '150.00',
      currency: 'USD',
    });
    expect(money({ amount: 99.5, currency: 'EUR' })).toEqual({
      amount: '99.5',
      currency: 'EUR',
    });
    expect(money({})).toBeUndefined();
    for (const record of [
      { amount: 1e21, currency: 'USD' },
      { amount: Number.NaN, currency: 'USD' },
      { amount: '1,200', currency: 'USD' },
      { amount: '10', currency: 'DOLLARS' },
      { amount: '10' },
      { currency: 'USD' },
    ]) {
      expect(() => money(record)).toThrow(
        expect.objectContaining({ code: 'CONNECTOR_INVALID_FIELD' }),
      );
    }
  });

  it('reads counts, booleans and date-times strictly', () => {
    expect(read({ n: '5' }).nonNegativeInteger('n', ['n'])).toBe(5);
    expect(read({ n: 0 }).nonNegativeInteger('n', ['n'])).toBe(0);
    for (const n of [-1, 1.5, 'five', '']) {
      expect(() => read({ n }).nonNegativeInteger('n', ['n'])).toThrow(
        expect.objectContaining({ code: 'CONNECTOR_INVALID_FIELD' }),
      );
    }
    expect(() => read({ b: 'yes' }).boolean('b', ['b'])).toThrow(
      expect.objectContaining({ code: 'CONNECTOR_INVALID_FIELD' }),
    );
    expect(read({ d: '2026-11-02T18:00:00+05:00' }).dateTime('d', ['d'])).toBe(
      '2026-11-02T18:00:00+05:00',
    );
    expect(() => read({ d: '02/11/2026' }).dateTime('d', ['d'])).toThrow(
      expect.objectContaining({ code: 'CONNECTOR_INVALID_FIELD' }),
    );
  });

  it('maps unknown enum values to the honest fallback', () => {
    const map = (value: string): 'OPEN' | undefined =>
      value === 'OPEN' ? 'OPEN' : undefined;
    expect(read({ s: 'open' }).enumValue('s', ['s'], map, 'UNKNOWN')).toBe(
      'OPEN',
    );
    expect(read({ s: 'weird' }).enumValue('s', ['s'], map, 'UNKNOWN')).toBe(
      'UNKNOWN',
    );
    expect(read({}).enumValue('s', ['s'], map, 'UNKNOWN')).toBe('UNKNOWN');
  });

  it('copies only explicitly mapped attributes', () => {
    expect(
      read({ level: 'B1', secret: 'internal', nested: { a: [1] } }).attributes({
        level: 'level',
        shape: 'nested',
      }),
    ).toEqual({ level: 'B1', shape: { a: [1] } });
  });
});

describe('outbound requestBody configuration', () => {
  const withLead = (requestBody: unknown): Record<string, unknown> => ({
    ...base,
    endpoints: { createLead: { method: 'POST', path: '/leads', requestBody } },
  });

  it('accepts canonical sources and static values', () => {
    expect(() =>
      parseGenericRestConnectorConfig(
        withLead({
          'customer.name': { from: 'contact.name', required: true },
          'meta.level': { from: 'slots.level' },
          source: { value: 'bot' },
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    [{ x: { from: 'contact.email' } }],
    [{ x: { from: 'details.anything' } }],
    [{ x: { from: 'slots.__proto__' } }],
    [{ '__proto__.polluted': { value: 1 } }],
    [{ a: { value: 1 }, 'a.b': { value: 2 } }],
    [{ x: { from: 'summary', value: 'both' } }],
    [{ x: { expression: 'process.env' } }],
  ])('rejects unsafe or invalid mapping %o', (requestBody) => {
    rejects(withLead(requestBody));
  });

  it('rejects requestBody on read endpoints and alongside body', () => {
    rejects({
      ...base,
      endpoints: {
        listItems: { path: '/items', requestBody: { x: { value: 1 } } },
      },
    });
    rejects({
      ...base,
      endpoints: {
        createLead: {
          method: 'POST',
          path: '/leads',
          body: { a: 1 },
          requestBody: { b: { value: 2 } },
        },
      },
    });
  });

  it('rejects configuration that tries to weaken transport security', () => {
    for (const key of [
      'outboundUrlPolicy',
      'rejectUnauthorized',
      'tls',
      'ca',
      'allowPrivateNetworks',
      'exemptLoopbackAddresses',
    ]) {
      rejects({ ...base, [key]: true });
    }
  });
});
