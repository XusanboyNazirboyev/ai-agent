import { describe, expect, it } from 'vitest';
import {
  AmocrmClient,
  AMOCRM_ENDPOINTS,
  amocrmOrigin,
} from './amocrm-client.js';
import { AmocrmConnector } from './amocrm-connector.js';
import {
  firstOpenStatus,
  parseLeadChanges,
  parseStatuses,
  toPortalStages,
} from './amocrm-rules.js';
import {
  DEFAULT_PIPELINES,
  MAIN_PIPELINE_ID,
  pipelinesResponse,
  SECOND_PIPELINE_ID,
  TEST_SUBDOMAIN,
  TEST_TOKEN,
} from './testing/amocrm-fixtures.js';
import { FakeAccount } from './testing/fake-account.js';

const fast = { minIntervalMs: 0, sleep: async (): Promise<void> => undefined };

function client(account: FakeAccount, extra = {}): AmocrmClient {
  return new AmocrmClient({
    subdomain: TEST_SUBDOMAIN,
    token: TEST_TOKEN,
    transport: account.transport,
    ...fast,
    ...extra,
  });
}

function connector(
  account: FakeAccount,
  config: Record<string, unknown> = {},
): AmocrmConnector {
  return new AmocrmConnector(
    { tenantId: 't1', connectorKey: 'amocrm' },
    {
      subdomain: TEST_SUBDOMAIN,
      tokenSecretRef: 'store:amocrm_token',
      ...config,
    },
    {
      resolveSecret: { resolve: (): string => TEST_TOKEN },
      client: { transport: account.transport, ...fast },
    },
  );
}

describe('AmocrmClient', () => {
  it('builds the fixed host and validates the subdomain', () => {
    expect(amocrmOrigin('my-shop1')).toBe('https://my-shop1.amocrm.ru');
    for (const bad of [
      '',
      'A',
      'a.b',
      'a/b',
      'x.kommo.com',
      'a b',
      'a'.repeat(64),
    ])
      expect(() => amocrmOrigin(bad)).toThrow();
    expect(
      () => new AmocrmClient({ subdomain: 'evil.com/', token: 'x'.repeat(12) }),
    ).toThrow();
  });

  it('sends a bearer token to the fixed host and only allow-listed calls', async () => {
    const account = new FakeAccount();
    await client(account).get('/api/v4/account');
    expect(account.calls[0]).toMatchObject({
      host: 'example.amocrm.ru',
      authorization: `Bearer ${TEST_TOKEN}`,
    });
    expect(AMOCRM_ENDPOINTS).toHaveLength(4);
    expect(() => client(account).get('/api/v4/contacts')).toThrow(
      /not allowed/,
    );
    expect(() => client(account).post('/api/v4/leads', [])).toThrow(
      /not allowed/,
    );
    expect(() => client(account).get('/api/v4/leads', { 'a b': 1 })).toThrow();
    expect(account.calls).toHaveLength(1);
  });

  it('paces to at most 5 requests a second', async () => {
    const account = new FakeAccount();
    let t = 0;
    const waits: number[] = [];
    const c = new AmocrmClient({
      subdomain: TEST_SUBDOMAIN,
      token: TEST_TOKEN,
      transport: account.transport,
      minIntervalMs: 200,
      now: (): number => t,
      sleep: async (ms: number): Promise<void> => {
        waits.push(ms);
        t += ms;
      },
    });
    await Promise.all([1, 2, 3].map(() => c.get('/api/v4/account')));
    expect(waits).toEqual([200, 200]);
  });

  it('retries 429 with backoff, then gives up as rate limited', async () => {
    const account = new FakeAccount();
    account.queue('/api/v4/account', { status: 429, body: {} });
    const sleeps: number[] = [];
    await client(account, {
      sleep: async (ms: number) => void sleeps.push(ms),
    }).get('/api/v4/account');
    expect(account.callsTo('/api/v4/account')).toHaveLength(2);
    expect(sleeps).toContain(2000);

    for (let i = 0; i < 4; i++)
      account.queue('/api/v4/account', { status: 429, body: {} });
    await expect(client(account).get('/api/v4/account')).rejects.toMatchObject({
      code: 'AMOCRM_RATE_LIMITED',
    });
  });

  it('stops on 403 and sends nothing more for a while', async () => {
    const account = new FakeAccount();
    account.queue('/api/v4/account', { status: 403, body: {} });
    const c = client(account);
    await expect(c.get('/api/v4/account')).rejects.toMatchObject({
      code: 'AMOCRM_FORBIDDEN',
    });
    await expect(c.get('/api/v4/leads/pipelines')).rejects.toMatchObject({
      code: 'AMOCRM_FORBIDDEN',
    });
    expect(account.calls).toHaveLength(1);
  });

  it('maps statuses and never puts the token in an error', async () => {
    const account = new FakeAccount();
    account.token = 'other';
    const err = await client(account)
      .get('/api/v4/account')
      .catch((e: unknown) => e as Error & { code: string });
    expect(err).toMatchObject({ code: 'AMOCRM_UNAUTHORIZED' });
    expect(JSON.stringify([(err as Error).message, err])).not.toContain(
      TEST_TOKEN,
    );
    account.queue('/api/v4/leads', {
      status: 500,
      body: { detail: TEST_TOKEN },
    });
    const e2 = (await client(account)
      .get('/api/v4/leads')
      .catch((e: unknown) => e)) as Error;
    expect(e2.message).not.toContain(TEST_TOKEN);
    expect(e2).toMatchObject({ retryable: true, executed: 'unknown' });
  });
});

describe('amoCRM rules', () => {
  const body = pipelinesResponse(DEFAULT_PIPELINES);
  it('maps 142 to success and 143 to failure, drops the unsorted inbox', () => {
    const stages = toPortalStages(parseStatuses(body, MAIN_PIPELINE_ID));
    expect(stages.map((s) => [s.id, s.semantics])).toEqual([
      ['32392159', 'process'],
      ['32392165', 'process'],
      ['142', 'success'],
      ['143', 'failure'],
    ]);
    expect(firstOpenStatus(parseStatuses(body, MAIN_PIPELINE_ID))?.id).toBe(
      32392159,
    );
    expect(parseStatuses(body, 999)).toEqual([]);
  });
  it('parses changes and drops deleted, malformed and other-pipeline leads', () => {
    const changes = parseLeadChanges(
      {
        _embedded: {
          leads: [
            { id: 1, status_id: 142, pipeline_id: 5, updated_at: 1000 },
            {
              id: 2,
              status_id: 142,
              pipeline_id: 5,
              updated_at: 1000,
              is_deleted: true,
            },
            { id: 3, status_id: 1, pipeline_id: 6, updated_at: 1000 },
            { id: 'x', status_id: 1, updated_at: 1 },
            null,
          ],
        },
      },
      5,
    );
    expect(changes).toEqual([
      { externalId: '1', stageId: '142', updatedAt: new Date(1_000_000) },
    ]);
    expect(parseLeadChanges(null, 5)).toEqual([]);
  });
});

describe('AmocrmConnector', () => {
  const lead = {
    contact: { name: 'Synthetic <b>Customer</b>', phone: '+998 90 000 00 17' },
    score: 'WARM',
    summary: 'Asked about the evening group.',
    slots: {},
    reasonCodes: [],
  } as never;

  it('creates a lead with contact and phone in the first open stage', async () => {
    const account = new FakeAccount();
    const out = await connector(account, {
      pipelineId: SECOND_PIPELINE_ID,
    }).createLead(lead, { idempotencyKey: 'lead-key-0001' });
    expect(out.crmLeadId).toMatch(/^\d+$/u);
    const post = account.callsTo('/api/v4/leads/complex')[0];
    expect(post?.body).toEqual([
      {
        name: 'Telegram: Synthetic ‹b›Customer‹/b›',
        pipeline_id: SECOND_PIPELINE_ID,
        status_id: 32400001,
        request_id: 'lead-key-0001',
        _embedded: {
          contacts: [
            {
              name: 'Synthetic ‹b›Customer‹/b›',
              custom_fields_values: [
                {
                  field_code: 'PHONE',
                  values: [{ enum_code: 'WORK', value: '+998900000017' }],
                },
              ],
            },
          ],
        },
      },
    ]);
  });

  it('without a chosen pipeline sends no placement; without contact sends none', async () => {
    const account = new FakeAccount();
    await connector(account).createLead({
      ...(lead as object),
      contact: {},
    } as never);
    const body = (
      account.callsTo('/api/v4/leads/complex')[0]?.body as Array<
        Record<string, unknown>
      >
    )[0];
    expect(body).toEqual({ name: 'Telegram: new inquiry' });
    expect(account.callsTo('/api/v4/leads/pipelines')).toHaveLength(0);
  });

  it('is a lead sink only and never repeats an unclear write', () => {
    const c = connector(new FakeAccount());
    expect(c.capabilities).toMatchObject({ createLead: true, search: false });
    expect(c.writeIdempotency).toBe('none');
  });

  it('polls only the chosen pipeline with the documented filters', async () => {
    const account = new FakeAccount();
    const c = connector(account, { pipelineId: MAIN_PIPELINE_ID });
    await c.listChangedLeads(new Date(1_700_000_000_000), 1);
    expect(account.callsTo('/api/v4/leads')[0]?.query).toEqual({
      limit: '250',
      page: '2',
      'order[updated_at]': 'asc',
      'filter[updated_at][from]': '1700000000',
      'filter[pipeline_id][0]': String(MAIN_PIPELINE_ID),
    });
    const none = connector(account);
    expect(await none.listChangedLeads(new Date(), 0)).toEqual([]);
    expect(await none.listStages()).toEqual([]);
  });
});
