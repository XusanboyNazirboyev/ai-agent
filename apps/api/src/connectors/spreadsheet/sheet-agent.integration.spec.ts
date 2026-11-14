/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extraction, runTurn } from '../../agent/testing/agent-harness.js';
import { ScriptedLlmProvider } from '../../core/llm/scripted-llm-provider.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { TRAVEL_PACK } from '../../packs/travel/travel.pack.js';
import { createPostgresAdapter } from '../../persistence/postgres-adapter.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { parseSheet } from './csv-reader.js';
import { suggestMapping } from './field-suggest.js';
import { mapSheet } from './row-mapper.js';
import { PrismaSheetCatalogStore } from './sheet-catalog.store.js';
import { SpreadsheetConnector } from './spreadsheet-connector.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Sheet agent tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
const store = new PrismaSheetCatalogStore(prisma);
afterAll(async () => {
  await db.$disconnect();
});

const SAMPLE = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../../../docs/samples/tourism-price-list.sample.csv',
  ),
  'utf8',
);
const UPLOADED = new Date('2026-03-01T08:00:00Z');

async function tenantWithList(): Promise<string> {
  const t = await db.tenant.create({
    data: {
      slug: `sheetagent-${randomUUID()}`,
      name: 'Sheet agent fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Asia/Tashkent',
      packKey: 'travel',
      packVersion: '1',
    },
  });
  const sheet = parseSheet(SAMPLE);
  const mapping = suggestMapping(sheet.header);
  await store.replace(t.id, {
    name: 'Price list',
    sourceFilename: 'tours.csv',
    mapping,
    options: {},
    freshnessDays: 3,
    uploadedAt: UPLOADED,
    result: mapSheet(sheet, mapping),
  });
  return t.id;
}

const connectorAt = (tenantId: string, now: Date) =>
  new SpreadsheetConnector(
    { tenantId, connectorKey: 'spreadsheet' },
    store,
    () => now,
  );

const SLOTS = { destination: 'Dubai', travelMonth: 'july', partySize: '2' };

async function priceTurn(options: {
  tenantId: string;
  now: Date;
  offerCode: string;
  reply: string;
  second?: string;
  destination?: string;
}) {
  const connector = connectorAt(options.tenantId, options.now);
  const rixos = (await connector.searchItems({ title: 'rixos' }))[0]!;
  const offer = (await connector.getOffers(rixos.id)).find(
    (o) => o.sourceEntityId === options.offerCode,
  )!;
  const provider = new ScriptedLlmProvider([
    extraction(
      { ...SLOTS, destination: options.destination ?? SLOTS.destination },
      'price',
      'en',
      'Latn',
      TRAVEL_PACK,
    ),
    {
      kind: 'tools',
      toolCalls: [{ name: 'list_offers', input: { itemId: rixos.id } }],
    },
    {
      kind: 'tools',
      toolCalls: [{ name: 'get_quote', input: { offerId: offer.id } }],
    },
    { kind: 'tools', text: options.reply },
    // A second draft, in case the first one is refused.
    {
      kind: 'tools',
      text: options.second ?? 'Let me check this with a colleague.',
    },
  ]);
  return runTurn({
    provider,
    text: 'How much is the Dubai tour?',
    connector,
    pack: TRAVEL_PACK,
    now: options.now,
    scope: { tenantId: options.tenantId, conversationId: 'conversation-eval' },
  });
}

const toolLog = (run: Awaited<ReturnType<typeof priceTurn>>): string[] =>
  run.result.tools.map((t) => `${t.origin}:${t.name}:${t.status}`);
const plain = (text: string): string => text.replace(/\s/gu, ' ');

describe('the agent answers from an uploaded price list (ADR 064)', () => {
  it('states the exact price and departure from the sheet, rendered by code with provenance', async () => {
    const tenantId = await tenantWithList();
    const run = await priceTurn({
      tenantId,
      now: new Date('2026-03-02T10:00:00Z'),
      offerCode: 'DXB-RIX-5-0314',
      reply: '{{F1}}: {{F19}} per person.',
    });
    expect(run.result.outcome).toBe('ANSWERED');
    expect(run.result.regenerated).toBe(false);
    expect(toolLog(run)).toEqual([
      'code:search_catalog:ok',
      'model:list_offers:ok',
      'model:get_quote:ok',
    ]);
    const reply = plain(run.result.reply);
    expect(reply).toContain('820');
    expect(reply).toContain('per person');
    // A price is per person (the customer must not read it as the trip's total),
    // both as listed and as quoted.
    const listed = run.result.facts.find((fact) => fact.id === 'F3');
    expect(listed).toMatchObject({
      value: { kind: 'price', pricingBasis: 'PER_PERSON' },
    });
    const quote = run.result.facts.find((fact) => fact.id === 'F19');
    expect(quote).toMatchObject({
      value: {
        kind: 'price',
        confirmedQuote: true,
        money: { amount: '820', currency: 'USD' },
      },
      provenance: {
        tool: 'get_quote',
        connectorKey: 'spreadsheet',
        sourceSystem: 'spreadsheet',
        live: true,
      },
    });
  });

  it('never states a price the model made up, even when it tries', async () => {
    const tenantId = await tenantWithList();
    const run = await priceTurn({
      tenantId,
      now: new Date('2026-03-02T10:00:00Z'),
      offerCode: 'DXB-RIX-5-0314',
      reply: 'It costs 500 dollars per person.',
    });
    expect(plain(run.result.reply)).not.toContain('500');
    expect(run.result.outcome).not.toBe('ANSWERED_WITH_INVENTED_PRICE');
  });

  it('gives no price from a list older than its freshness window: the quote is refused, a listed price is not live, the turn hands over', async () => {
    const tenantId = await tenantWithList();
    // The sheet was uploaded on 2026-03-01 and is valid for 3 days.
    const run = await priceTurn({
      tenantId,
      now: new Date('2026-03-06T10:00:00Z'),
      offerCode: 'DXB-RIX-5-0314',
      // Both drafts quote a listed price: neither may be shown.
      reply: '{{F1}}: {{F3}} per person.',
      second: '{{F1}}: {{F3}} per person.',
    });
    expect(toolLog(run)).toContain('model:get_quote:error');
    expect(run.result.outcome).toBe('HANDOVER');
    expect(run.result.handover).toBe('GUARDRAIL');
    // The agent core itself sees the expired offers: no price, seat or date fact
    // is made from them, and the quote is refused by the connector.
    expect(run.result.tools.map((t) => `${t.name}:${t.outcome}`)).toEqual([
      'search_catalog:FOUND',
      'list_offers:STALE',
      'get_quote:UNAVAILABLE',
    ]);
    expect(run.result.facts.map((f) => f.value.kind)).toEqual([
      'title',
      'title',
    ]);
    const reply = plain(run.result.reply);
    expect(reply).not.toContain('820');
    expect(reply).not.toContain('860');
    // The same list, fresh, is quoted (previous test): only age changed.
  });

  it('says nothing was found, with no price, when the destination is not in the list', async () => {
    const tenantId = await tenantWithList();
    const connector = connectorAt(tenantId, new Date('2026-03-02T10:00:00Z'));
    const provider = new ScriptedLlmProvider([
      extraction(
        { ...SLOTS, destination: 'Paris' },
        'price',
        'en',
        'Latn',
        TRAVEL_PACK,
      ),
    ]);
    const { result } = await runTurn({
      provider,
      text: 'How much is the Paris tour?',
      connector,
      pack: TRAVEL_PACK,
      now: new Date('2026-03-02T10:00:00Z'),
      scope: { tenantId, conversationId: 'conversation-eval' },
    });
    expect(result.outcome).toBe('NO_RESULTS');
    // Only the code's own searches ran, all found nothing, and the model was never
    // given a tool: there is nothing it could quote.
    expect(result.tools.length).toBeGreaterThan(0);
    expect(
      result.tools.every(
        (t) =>
          t.origin === 'code' &&
          t.name === 'search_catalog' &&
          t.outcome === 'NOT_FOUND',
      ),
    ).toBe(true);
    expect(plain(result.reply)).not.toMatch(/\d{3}/u);
    expect(result.facts).toEqual([]);
  });

  it('reports a sold-out departure as sold out', async () => {
    const tenantId = await tenantWithList();
    const run = await priceTurn({
      tenantId,
      now: new Date('2026-03-02T10:00:00Z'),
      offerCode: 'DXB-RIX-5-0328',
      reply: 'Availability: {{F16}}.',
    });
    const availability = run.result.facts.filter(
      (f) => f.value.kind === 'availability',
    );
    expect(
      availability.some((f) => JSON.stringify(f.value).includes('SOLD_OUT')),
    ).toBe(true);
  });
});
