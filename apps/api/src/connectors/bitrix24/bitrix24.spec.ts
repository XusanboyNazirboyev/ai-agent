import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeadInput } from '../contracts/canonical.js';
import {
  ConnectorErrorCategory,
  ConnectorError,
} from '../interfaces/errors.js';
import { MockConnector } from '../mock/mock-connector.js';
import {
  bitrix24ConnectorRegistration,
  mockConnectorRegistration,
} from '../registry/registrations.js';
import { ConnectorRegistry } from '../registry/connector-registry.js';
import { EnvSecretResolver } from '../registry/secret-resolver.js';
import { describeConnectorConformance } from '../testing/conformance.js';
import {
  BITRIX24_METHODS,
  Bitrix24Client,
  LEAD_ENTITY_TYPE_ID,
  assertAllowed,
  parseWebhookUrl,
  restTransport,
} from './bitrix24-client.js';
import {
  Bitrix24Connector,
  TITLE_MAX,
  commentText,
  duplicateView,
  normalizePhone,
  plainText,
} from './bitrix24-connector.js';
import {
  INVALID_CREDENTIALS,
  OPERATION_TIME_LIMIT,
  QUERY_LIMIT_EXCEEDED,
  TEST_WEBHOOK_URL,
} from './testing/bitrix24-fixtures.js';
import { FakePortal } from './testing/fake-portal.js';

const SECRET_CODE = 'REDACTED0000test';
const CONTEXT = { tenantId: 'tenant-1', connectorKey: 'bitrix24' };
const CONFIG = {
  webhookSecretRef: 'env:CONNECTOR_SECRET_BITRIX24_WEBHOOK_URL',
};

function connectorFor(
  portal: FakePortal,
  sleep = vi.fn(async (): Promise<void> => undefined),
): Bitrix24Connector {
  return new Bitrix24Connector(CONTEXT, CONFIG, {
    resolveSecret: { resolve: (): string => TEST_WEBHOOK_URL },
    client: { transport: portal.transport, minIntervalMs: 0, sleep },
  });
}

const lead = (overrides: Partial<LeadInput> = {}): LeadInput => ({
  contact: { name: 'Synthetic Customer', phone: '+998 90 000-00-17' },
  summary: 'Asked about the IELTS evening group.',
  slots: { course: 'IELTS', schedule: 'evening' },
  score: 'WARM',
  reasonCodes: ['PRICE_ASKED'],
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describeConnectorConformance({
  name: 'bitrix24 (fake portal, recorded shapes)',
  setup: async () => ({ connector: connectorFor(new FakePortal()) }),
  samples: {},
});

describe('Bitrix24 method allow-list', () => {
  it('refuses any method outside the list, before any request', async () => {
    const portal = new FakePortal();
    const client = new Bitrix24Client({
      webhookUrl: TEST_WEBHOOK_URL,
      transport: portal.transport,
      minIntervalMs: 0,
    });
    for (const [method, params] of [
      ['crm.lead.delete', { id: 1 }],
      ['crm.deal.add', {}],
      ['batch', {}],
      ['user.get', {}],
    ] as const) {
      expect(() => client.call(method as never, params)).toThrowError(
        expect.objectContaining({ code: 'BITRIX24_METHOD_NOT_ALLOWED' }),
      );
    }
    expect(portal.calls).toHaveLength(0);
  });

  it('refuses an allowed method aimed at another entity', () => {
    for (const [method, params] of [
      ['crm.item.add', { entityTypeId: 2, fields: {} }],
      ['crm.item.list', { entityTypeId: 3 }],
      ['crm.item.fields', {}],
      ['crm.timeline.comment.add', { fields: { ENTITY_TYPE: 'deal' } }],
      ['crm.timeline.comment.list', { filter: { ENTITY_TYPE: 'deal' } }],
      ['crm.duplicate.findbycomm', { type: 'EMAIL', values: [] }],
    ] as const) {
      expect(() => assertAllowed(method, params)).toThrow(ConnectorError);
    }
    expect(() =>
      assertAllowed('crm.item.add', { entityTypeId: LEAD_ENTITY_TYPE_ID }),
    ).not.toThrow();
    expect(BITRIX24_METHODS).toHaveLength(7);
  });
});

describe('Bitrix24 webhook URL', () => {
  it('accepts only https /rest/<user>/<code>/ without query or credentials', () => {
    expect(parseWebhookUrl(TEST_WEBHOOK_URL).pathname).toBe(
      `/rest/1/${SECRET_CODE}/`,
    );
    for (const bad of [
      'http://portal.example.test/rest/1/REDACTED0000test/',
      'https://portal.example.test/rest/1/REDACTED0000test/?x=1',
      'https://user:pw@portal.example.test/rest/1/REDACTED0000test/',
      'https://portal.example.test/rest/REDACTED0000test/',
      'https://portal.example.test/api/1/REDACTED0000test/',
      'not a url',
    ]) {
      const error = ((): Error | undefined => {
        try {
          parseWebhookUrl(bad);
        } catch (caught) {
          return caught as Error;
        }
      })();
      expect(error?.message).toMatch(/^Bitrix24 webhook URL /u);
      expect(error?.message).not.toContain('REDACTED0000test');
      expect(error?.message).not.toContain('portal.example.test');
    }
  });

  it('fails closed when the secret reference does not resolve', () => {
    expect(
      () =>
        new Bitrix24Connector(CONTEXT, CONFIG, {
          resolveSecret: { resolve: (): undefined => undefined },
        }),
    ).toThrowError(
      expect.objectContaining({ code: 'CONNECTOR_SECRET_MISSING' }),
    );
  });
});

describe('Bitrix24 secret hygiene', () => {
  it('never puts the webhook code in errors or logs', async () => {
    const logged: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const)
      vi.spyOn(Logger.prototype, level).mockImplementation(
        (message: unknown) => {
          logged.push(String(message));
        },
      );
    const portal = new FakePortal();
    portal.queue('crm.settings.mode.get', {
      status: 401,
      body: INVALID_CREDENTIALS,
    });
    const connector = connectorFor(portal);
    const error = await connector
      .createLead(lead())
      .catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ code: 'BITRIX24_INVALID_CREDENTIALS' });
    portal.queue('crm.timeline.comment.add', { status: 500, body: {} });
    await connector.createLead(lead());
    const text = [
      (error as Error).message,
      JSON.stringify(error),
      ...logged,
    ].join('\n');
    expect(text).not.toContain(SECRET_CODE);
    expect(text).not.toContain('portal.example.test');
  });

  it('rebuilds transport errors without their message or cause', async () => {
    const leaky = new ConnectorError({
      message: `Request to https://portal.example.test/rest/1/${SECRET_CODE}/crm.item.add.json failed`,
      code: 'CONNECTOR_UNAVAILABLE',
      category: ConnectorErrorCategory.UNAVAILABLE,
      retryable: true,
      executed: 'unknown',
    });
    const transport = restTransport(
      {},
      {
        send: async () => {
          throw leaky;
        },
      },
    );
    const error = (await transport(TEST_WEBHOOK_URL, {}).catch(
      (caught: unknown) => caught,
    )) as ConnectorError;
    expect(error.message).not.toContain(SECRET_CODE);
    expect(error.cause).toBeUndefined();
    expect(error).toMatchObject({
      code: 'CONNECTOR_UNAVAILABLE',
      executed: 'unknown',
    });
  });
});

describe('Bitrix24 lead mapping', () => {
  it('maps the lead to crm.item.add fields and the summary to a comment', async () => {
    const portal = new FakePortal();
    const result = await connectorFor(portal).createLead(lead(), {
      idempotencyKey: 'lead:tenant-1:abc12345',
    });
    const [add] = portal.callsOf('crm.item.add');
    expect(add?.params).toEqual({
      entityTypeId: 1,
      fields: {
        title: 'Telegram: Synthetic Customer',
        name: 'Synthetic Customer',
        sourceId: 'OTHER',
        sourceDescription: 'tezda (Telegram)',
        comments: 'Score WARM; reasons: PRICE_ASKED',
        originatorId: 'tezda',
        originId: 'lead:tenant-1:abc12345',
        fm: [{ typeId: 'PHONE', valueType: 'MOBILE', value: '+998900000017' }],
      },
    });
    expect(result.crmLeadId).toBe(String(portal.leads[0]?.id));
    expect(portal.comments).toEqual([
      {
        leadId: portal.leads[0]?.id,
        text: 'Telegram conversation (tezda)\nAsked about the IELTS evening group.\n\nCollected details:\ncourse: IELTS\nschedule: evening\n\ntezda ref: lead:tenant-1:abc12345',
      },
    ]);
  });

  it('caps the title at 255 characters and neutralizes markup', () => {
    expect(plainText('x'.repeat(400), TITLE_MAX)).toHaveLength(TITLE_MAX);
    expect(plainText('[b]hi[/b] <script>x</script>\u0007', 100)).toBe(
      '⟦b⟧hi⟦/b⟧ ‹script›x‹/script›',
    );
    expect(
      commentText(
        lead({
          summary: '[url=https://portal.example.test]click[/url]',
          slots: {},
        }),
      ),
    ).not.toMatch(/[[\]<>]/u);
  });

  it('normalizes phones and drops what is not a phone', () => {
    expect(normalizePhone('+998 (90) 000-00-17')).toBe('+998900000017');
    expect(normalizePhone('00998900000017')).toBe('+998900000017');
    expect(normalizePhone('90 000 00 17')).toBe('900000017');
    expect(normalizePhone('12')).toBeUndefined();
    expect(normalizePhone(undefined)).toBeUndefined();
  });

  it('rejects invalid input as a validation error without a request', async () => {
    const portal = new FakePortal();
    await expect(
      connectorFor(portal).createLead({ summary: '' } as unknown as LeadInput),
    ).rejects.toMatchObject({ category: ConnectorErrorCategory.VALIDATION });
    expect(portal.calls).toHaveLength(0);
  });
});

describe('Bitrix24 duplicate check (by phone, in code)', () => {
  it('comments on an existing lead and never changes its fields', async () => {
    const portal = new FakePortal();
    const connector = connectorFor(portal);
    const first = await connector.createLead(lead());
    const second = await connector.createLead(
      lead({ summary: 'Came back later.' }),
    );
    expect(second.crmLeadId).toBe(first.crmLeadId);
    expect(portal.callsOf('crm.item.add')).toHaveLength(1);
    expect(portal.comments.map((c) => c.text)).toEqual([
      expect.stringContaining('IELTS evening'),
      expect.stringContaining('Came back later.'),
    ]);
  });

  it('a retried write on the existing-lead path adds exactly one comment', async () => {
    const portal = new FakePortal();
    // The portal already has a lead with this phone (from another conversation).
    portal.leads.push({
      id: 7,
      fields: { fm: [{ typeId: 'PHONE', value: '+998900000017' }] },
    });
    const connector = connectorFor(portal);
    const context = { idempotencyKey: 'createLead:lead:retry0001' };
    const first = await connector.createLead(lead(), context);
    const retry = await connector.createLead(lead(), context);
    expect(first).toEqual({ crmLeadId: '7' });
    expect(retry).toEqual(first);
    expect(portal.comments).toHaveLength(1);
    expect(portal.comments[0]?.text).toContain(
      'tezda ref: createLead:lead:retry0001',
    );
    expect(portal.callsOf('crm.item.add')).toHaveLength(0);
  });

  it('treats numeric-string ids in the duplicates response as a match', async () => {
    const portal = new FakePortal();
    portal.leads.push({ id: 7, fields: {} });
    portal.queue('crm.duplicate.findbycomm', {
      status: 200,
      body: { result: { LEAD: ['7'] } },
    });
    const result = await connectorFor(portal).createLead(lead());
    expect(result).toEqual({ crmLeadId: '7' });
    expect(portal.callsOf('crm.item.add')).toHaveLength(0);
    expect(portal.comments.map((c) => c.leadId)).toEqual([7]);
  });

  it.each(['S', 'F'])(
    'does not let a closed lead (stage %s) absorb a new inquiry',
    async (stage) => {
      const portal = new FakePortal();
      portal.leads.push({
        id: 7,
        fields: {
          stageSemanticId: stage,
          fm: [{ typeId: 'PHONE', value: '+998900000017' }],
        },
      });
      portal.contactsByPhone.set('+998900000017', 4);
      const result = await connectorFor(portal).createLead(lead());
      expect(result.crmLeadId).not.toBe('7');
      expect(portal.callsOf('crm.item.add')[0]?.params.fields).toMatchObject({
        contactId: 4,
      });
      expect(portal.comments.map((c) => c.leadId)).not.toContain(7);
    },
  );

  it('links a new lead to a matching contact', async () => {
    const portal = new FakePortal();
    portal.contactsByPhone.set('+998900000017', 4);
    await connectorFor(portal).createLead(lead());
    expect(portal.callsOf('crm.item.add')[0]?.params.fields).toMatchObject({
      contactId: 4,
    });
  });

  it('skips the check without a phone and exposes only {exists, internalId}', async () => {
    const portal = new FakePortal();
    await connectorFor(portal).createLead(
      lead({ contact: { name: 'No Phone' } }),
    );
    expect(portal.callsOf('crm.duplicate.findbycomm')).toHaveLength(0);
    expect(duplicateView({ CONTACT: [4] })).toEqual({
      exists: true,
      internalId: 'CONTACT:4',
    });
    expect(duplicateView({})).toEqual({ exists: false, internalId: null });
  });
});

describe('Bitrix24 idempotency (lookup by originId)', () => {
  it('finds the lead a key created, and nothing for an unknown key', async () => {
    const portal = new FakePortal();
    const connector = connectorFor(portal);
    expect(connector.writeIdempotency).toBe('lookup');
    expect(
      await connector.findLeadByIdempotencyKey('lead:t:missing01'),
    ).toBeUndefined();
    const made = await connector.createLead(lead({ contact: {} }), {
      idempotencyKey: 'lead:t:key00001',
    });
    expect(await connector.findLeadByIdempotencyKey('lead:t:key00001')).toEqual(
      made,
    );
    expect(portal.callsOf('crm.item.list').at(-1)?.params).toEqual({
      entityTypeId: 1,
      select: ['id', 'originatorId', 'originId'],
      filter: { originatorId: 'tezda', originId: 'lead:t:key00001' },
    });
  });

  it('does not trust the first listed item: the key must match exactly', async () => {
    const portal = new FakePortal();
    portal.queue('crm.item.list', {
      status: 200,
      body: {
        result: {
          items: [
            { id: 9, originatorId: 'tezda', originId: 'lead:t:other001' },
          ],
        },
      },
    });
    await expect(
      connectorFor(portal).findLeadByIdempotencyKey('lead:t:key00001'),
    ).resolves.toBeUndefined();
  });

  it('reports a write whose outcome is unknown as uncertain', async () => {
    const portal = new FakePortal();
    portal.queue('crm.item.add', {
      status: 500,
      body: { error: 'INTERNAL_SERVER_ERROR' },
    });
    await expect(connectorFor(portal).createLead(lead())).rejects.toMatchObject(
      {
        executed: 'unknown',
      },
    );
  });
});

describe('Bitrix24 limits and backoff', () => {
  it('retries 503 QUERY_LIMIT_EXCEEDED with growing delays, then succeeds', async () => {
    const portal = new FakePortal();
    portal.queue('crm.settings.mode.get', {
      status: 503,
      body: QUERY_LIMIT_EXCEEDED,
    });
    portal.queue('crm.settings.mode.get', {
      status: 503,
      body: QUERY_LIMIT_EXCEEDED,
    });
    const sleep = vi.fn(async (_ms: number): Promise<void> => undefined);
    const client = new Bitrix24Client({
      webhookUrl: TEST_WEBHOOK_URL,
      transport: portal.transport,
      minIntervalMs: 0,
      sleep,
      random: (): number => 0.5,
    });
    await expect(client.call('crm.settings.mode.get')).resolves.toMatchObject({
      result: 1,
    });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
  });

  it('gives up after the retries as rate-limited and not executed', async () => {
    const portal = new FakePortal();
    for (let i = 0; i < 4; i++)
      portal.queue('crm.item.add', { status: 503, body: QUERY_LIMIT_EXCEEDED });
    const client = new Bitrix24Client({
      webhookUrl: TEST_WEBHOOK_URL,
      transport: portal.transport,
      minIntervalMs: 0,
      sleep: async (): Promise<void> => undefined,
    });
    await expect(
      client.call('crm.item.add', { entityTypeId: 1, fields: {} }),
    ).rejects.toMatchObject({
      code: 'BITRIX24_QUERY_LIMIT_EXCEEDED',
      category: ConnectorErrorCategory.RATE_LIMITED,
      executed: 'no',
    });
    expect(portal.callsOf('crm.item.add')).toHaveLength(4);
  });

  it('suspends a method after 429 OPERATION_TIME_LIMIT until the reset time', async () => {
    const portal = new FakePortal();
    let now = 1_793_000_000_000 - 30_000;
    const client = new Bitrix24Client({
      webhookUrl: TEST_WEBHOOK_URL,
      transport: portal.transport,
      minIntervalMs: 0,
      sleep: async (): Promise<void> => undefined,
      now: (): number => now,
    });
    await client.call('crm.settings.mode.get'); // operating_reset_at = 1_793_000_000
    portal.queue('crm.item.list', { status: 429, body: OPERATION_TIME_LIMIT });
    await expect(
      client.call('crm.item.list', { entityTypeId: 1 }),
    ).rejects.toMatchObject({
      code: 'BITRIX24_OPERATION_TIME_LIMIT',
      retryAfterMs: 30_000,
    });
    const before = portal.calls.length;
    await expect(
      client.call('crm.item.list', { entityTypeId: 1 }),
    ).rejects.toMatchObject({
      code: 'BITRIX24_OPERATION_TIME_LIMIT',
    });
    expect(portal.calls.length).toBe(before);
    now += 31_000;
    await expect(
      client.call('crm.item.list', { entityTypeId: 1 }),
    ).resolves.toBeDefined();
  });

  it('paces requests to the minimum interval, one at a time', async () => {
    const portal = new FakePortal();
    let now = 0;
    const waits: number[] = [];
    const client = new Bitrix24Client({
      webhookUrl: TEST_WEBHOOK_URL,
      transport: portal.transport,
      sleep: async (ms): Promise<void> => {
        waits.push(ms);
        now += ms;
      },
      now: (): number => now,
    });
    await Promise.all([
      client.call('crm.settings.mode.get'),
      client.call('crm.settings.mode.get'),
      client.call('crm.settings.mode.get'),
    ]);
    expect(waits).toEqual([1000, 1000]);
  });
});

describe('Bitrix24 simple CRM (no leads)', () => {
  it('refuses lead creation and writes nothing', async () => {
    const portal = new FakePortal();
    portal.mode = 2;
    await expect(connectorFor(portal).createLead(lead())).rejects.toMatchObject(
      {
        code: 'BITRIX24_LEADS_DISABLED',
      },
    );
    expect(portal.callsOf('crm.item.add')).toHaveLength(0);
    expect(portal.callsOf('crm.duplicate.findbycomm')).toHaveLength(0);
  });
});

describe('Bitrix24 registration and the mock lead switch', () => {
  it('registers lead creation only and resolves the webhook from the connector namespace', () => {
    const registry = new ConnectorRegistry(
      new EnvSecretResolver({
        CONNECTOR_SECRET_BITRIX24_WEBHOOK_URL: TEST_WEBHOOK_URL,
      }),
    );
    registry.register(bitrix24ConnectorRegistration());
    const connector = registry.create(CONTEXT, CONFIG);
    expect(connector.capabilities).toEqual({
      sync: false,
      search: false,
      liveQuote: false,
      availability: false,
      createLead: true,
      updateLead: false,
      createBooking: false,
      webhooks: false,
    });
    expect(() =>
      registry.create(
        { tenantId: 'tenant-2', connectorKey: 'bitrix24' },
        { webhookSecretRef: 'env:POSTGRES_PASSWORD' },
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'CONNECTOR_SECRET_MISSING' }),
    );
  });

  it('lets the mock switch lead creation off, so another connector is the lead sink', () => {
    const registry = new ConnectorRegistry(new EnvSecretResolver({}));
    registry.register(mockConnectorRegistration());
    const mock = registry.create(
      { tenantId: 'tenant-1', connectorKey: 'mock' },
      { sourceSystem: 'mock-education', createLead: false },
    ) as MockConnector;
    expect(mock.capabilities.createLead).toBe(false);
    expect(mock.capabilities.sync).toBe(true);
  });
});
