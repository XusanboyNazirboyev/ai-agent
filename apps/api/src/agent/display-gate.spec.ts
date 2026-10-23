import { describe, expect, it } from 'vitest';
import type { Quote } from '../connectors/contracts/canonical.js';
import {
  checkFactEvidence,
  displayPolicyFor,
  type EvidenceContext,
} from '../core/agent/display-gate.js';
import {
  FactStore,
  type Fact,
  type FactProvenance,
  type FactValue,
} from '../core/agent/facts.js';
import { checkDraft } from '../core/agent/guardrails.js';
import {
  ScriptedLlmProvider,
  type ScriptStep,
} from '../core/llm/scripted-llm-provider.js';
import { UZ_LATN } from '../locales/locale-packs.js';
import {
  educationConnector,
  extraction,
  runTurn,
} from './testing/agent-harness.js';

const now = new Date('2026-10-23T10:00:00Z');
const IELTS = 'mock-education:edu-ielts-001';
const WEEKDAY = 'mock-education:offer:ielts-group-weekday';

const PROVENANCE: FactProvenance = {
  tool: 'get_quote',
  connectorKey: 'mock',
  sourceSystem: 'mock-education',
  sourceEntityId: 'o1',
  retrievedAt: now.toISOString(),
  validUntil: '2026-10-23T10:30:00Z',
  tenantId: 't1',
  conversationId: 'c1',
  offerId: 'o1',
  live: true,
};
const PRICE: FactValue = {
  kind: 'price',
  money: { amount: '150.00', currency: 'USD' },
  confirmedQuote: true,
};
const LIVE: EvidenceContext = {
  tenantId: 't1',
  conversationId: 'c1',
  policy: displayPolicyFor({ liveQuote: true, availability: true }),
  now,
};

function fact(
  value: FactValue = PRICE,
  provenance: Partial<FactProvenance> = {},
): Fact {
  return { id: 'F1', value, provenance: { ...PROVENANCE, ...provenance } };
}

describe('display gate: evidence checks', () => {
  it('accepts a live, unexpired, correctly scoped quote', () => {
    expect(checkFactEvidence(fact(), LIVE)).toEqual([]);
  });

  it.each([
    ['tenant', { tenantId: 't2' }],
    ['conversation', { conversationId: 'c2' }],
  ])('rejects evidence from another %s', (_name, override) => {
    expect(checkFactEvidence(fact(PRICE, override), LIVE)).toEqual([
      'FACT_SCOPE_MISMATCH',
    ]);
  });

  it('rejects missing provenance: no binding, or a commercial fact with no offer', () => {
    const noScope = {
      ...fact(),
      provenance: {
        tool: 'get_quote',
        connectorKey: 'mock',
        sourceSystem: 'mock-education',
        sourceEntityId: 'o1',
        retrievedAt: now.toISOString(),
      },
    };
    expect(checkFactEvidence(noScope, LIVE)).toContain(
      'FACT_PROVENANCE_MISSING',
    );
    expect(
      checkFactEvidence(fact(PRICE, { offerId: undefined }), LIVE),
    ).toContain('FACT_PROVENANCE_MISSING');
    // A title is not a commercial claim and needs no offer.
    expect(
      checkFactEvidence(
        fact({ kind: 'title', text: 'IELTS' }, { offerId: undefined }),
        LIVE,
      ),
    ).toEqual([]);
  });

  it.each([
    ['expired', '2026-10-23T09:59:00Z'],
    ['expiring within the safety margin', '2026-10-23T10:00:05Z'],
    ['malformed', 'not-a-date'],
  ])('rejects a quote that is %s', (_name, validUntil) => {
    expect(checkFactEvidence(fact(PRICE, { validUntil }), LIVE)).toEqual([
      'STALE_FACT',
    ]);
  });

  it('rejects evidence that is too old or from the future', () => {
    expect(
      checkFactEvidence(
        fact(PRICE, { retrievedAt: '2026-10-23T09:50:00Z' }),
        LIVE,
      ),
    ).toEqual(['STALE_FACT']);
    expect(
      checkFactEvidence(
        fact(PRICE, { retrievedAt: '2026-10-23T11:00:00Z' }),
        LIVE,
      ),
    ).toEqual(['STALE_FACT']);
  });

  it('requires a live quote when the connector can quote, but not otherwise', () => {
    const listed = fact({ ...PRICE, confirmedQuote: false } as FactValue, {
      tool: 'list_offers',
      live: false,
    });
    expect(checkFactEvidence(listed, LIVE)).toEqual(['FACT_NOT_LIVE']);
    const noQuotes: EvidenceContext = {
      ...LIVE,
      policy: displayPolicyFor({ liveQuote: false, availability: true }),
    };
    expect(checkFactEvidence(listed, noQuotes)).toEqual([]);
  });

  it('requires a live availability check when the connector can check', () => {
    const listed = fact(
      { kind: 'availability', status: 'AVAILABLE' },
      { tool: 'list_offers', live: false },
    );
    const seats = fact({ kind: 'seats', count: 3 }, { live: false });
    expect(checkFactEvidence(listed, LIVE)).toEqual(['FACT_NOT_LIVE']);
    expect(checkFactEvidence(seats, LIVE)).toEqual(['FACT_NOT_LIVE']);
    expect(
      checkFactEvidence(
        fact({ kind: 'availability', status: 'AVAILABLE' }),
        LIVE,
      ),
    ).toEqual([]);
  });

  it('a quote flagged live but not confirmed is not a confirmed price', () => {
    expect(
      checkFactEvidence(
        fact({ ...PRICE, confirmedQuote: false } as FactValue),
        LIVE,
      ),
    ).toEqual(['FACT_NOT_LIVE']);
  });
});

describe('display gate: drafts', () => {
  function check(
    draft: string,
    options: {
      facts?: FactStore;
      customerTexts?: string[];
      evidence?: Partial<EvidenceContext>;
    } = {},
  ): ReturnType<typeof checkDraft> {
    const facts = options.facts ?? new FactStore();
    if (!options.facts) {
      facts.add({ kind: 'title', text: 'IELTS Preparation' }, PROVENANCE);
      facts.add(PRICE, PROVENANCE);
    }
    return checkDraft(draft, {
      facts,
      locale: UZ_LATN,
      customerTexts: options.customerTexts ?? [],
      timeZone: 'Asia/Tashkent',
      now,
      evidence: { ...LIVE, ...options.evidence },
    });
  }

  it('renders valid evidence in code', () => {
    const result = check('{{F1}} narxi {{F2}}.');
    expect(result.violations).toEqual([]);
    expect(result.rendered).toContain('IELTS Preparation');
  });

  it('does not accept a model-written reference as proof', () => {
    expect(check('Narxi {{F9}}').violations).toEqual(['UNKNOWN_FACT']);
  });

  it('blocks a reference whose stored evidence fails verification', () => {
    const facts = new FactStore();
    facts.add({ kind: 'title', text: 'IELTS' }, PROVENANCE);
    facts.add(PRICE, { ...PROVENANCE, tenantId: 'other-tenant' });
    const result = check('{{F1}} narxi {{F2}}.', { facts });
    expect(result.violations).toEqual(['FACT_SCOPE_MISMATCH']);
    expect(result.rendered).toBeUndefined();
  });

  it.each([
    ['a fabricated price', 'IELTS narxi 150 000 so‘m.', 'UNSOURCED_NUMBER'],
    ['a fabricated currency', 'Narxi {{F2}} dollar.', 'UNSOURCED_CURRENCY'],
    ['a discount', 'Bugun 20 foiz chegirma bor.', 'FORBIDDEN_CLAIM'],
    ['an unsupported date', 'Kurs 5 noyabrda boshlanadi.', 'UNSOURCED_NUMBER'],
    ['typed availability', 'Hozir joy bor.', 'UNSOURCED_AVAILABILITY'],
  ])('blocks %s', (_name, draft, violation) => {
    expect(check(draft).violations).toContain(violation);
  });

  it('does not flag numbers the customer wrote or that are not commercial claims', () => {
    const result = check('Rahmat! +998 90 123 45 67 raqamingizni oldik.', {
      customerTexts: [
        'Raqamim +998 90 123 45 67, 12-noyabr kuni qo‘ng‘iroq qiling',
      ],
    });
    expect(result.violations).toEqual([]);
    expect(
      check('12-noyabr kuni kelishamiz.', {
        customerTexts: ['12-noyabr kuni kelaman'],
      }).violations,
    ).toEqual([]);
  });
});

describe('display gate: turns', () => {
  const offersThenListedPrice = (final: string): ScriptStep[] => [
    extraction({ subject: 'IELTS' }, 'price'),
    {
      kind: 'tools',
      toolCalls: [{ name: 'list_offers', input: { itemId: IELTS } }],
    },
    { kind: 'tools', text: final },
  ];

  it('blocks a listed price when the connector can quote live, then regenerates once from a safe draft', async () => {
    // F2.. are listed facts from list_offers; the retry drops them.
    const provider = new ScriptedLlmProvider([
      ...offersThenListedPrice('{{F1}} narxi {{F3}}.'),
      {
        kind: 'tools',
        text: '{{F1}} kursi bo‘yicha operator narxni tasdiqlaydi.',
      },
    ]);
    const { result } = await runTurn({ provider, text: 'IELTS narxi qancha?' });
    const listedPrice = result.facts.find(
      (f) => f.value.kind === 'price' && !f.provenance.live,
    );
    expect(listedPrice).toBeDefined();
    expect(result.outcome).toBe('ANSWERED');
    expect(result.regenerated).toBe(true);
    expect(result.safety).toMatchObject({
      status: 'BLOCKED',
      gate: 'DISPLAY',
      reasonCodes: ['FACT_NOT_LIVE'],
    });
    expect(result.reply).not.toMatch(/\d/u);
  });

  it('falls back safely, with a typed escalation recommendation, when the regeneration also fails', async () => {
    const provider = new ScriptedLlmProvider([
      ...offersThenListedPrice('{{F1}} narxi {{F3}}.'),
      { kind: 'tools', text: '{{F1}} narxi taxminan 150 dollar.' },
    ]);
    const { result } = await runTurn({ provider, text: 'IELTS narxi qancha?' });
    expect(result).toMatchObject({
      outcome: 'HANDOVER',
      handover: 'GUARDRAIL',
      regenerated: true,
      safety: {
        status: 'ESCALATION_REQUIRED',
        gate: 'DISPLAY',
        escalation: { reason: 'GUARDRAIL', operatorNotified: false },
      },
    });
    expect(result.reply).toBe(UZ_LATN.templates.handover.GUARDRAIL);
    expect(result.reply).not.toMatch(/\d|dollar/iu);
  });

  it('never states a price when the live quote fails', async () => {
    const connector = educationConnector();
    connector.getQuote = async (): Promise<never> => {
      throw new Error('CRM down');
    };
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'price'),
      {
        kind: 'tools',
        toolCalls: [{ name: 'list_offers', input: { itemId: IELTS } }],
      },
      {
        kind: 'tools',
        toolCalls: [{ name: 'get_quote', input: { offerId: WEEKDAY } }],
      },
      { kind: 'tools', text: '{{F1}} narxi {{F3}}.' },
      { kind: 'tools', text: '{{F1}} narxi {{F3}}.' },
    ]);
    const { result } = await runTurn({
      provider,
      text: 'IELTS narxi qancha?',
      connector,
    });
    expect(result.outcome).toBe('HANDOVER');
    expect(result.safety?.status).toBe('ESCALATION_REQUIRED');
    expect(result.reply).not.toMatch(/\d/u);
    expect(
      result.tools.some((t) => t.name === 'get_quote' && t.status !== 'ok'),
    ).toBe(true);
  });

  it('refuses a quote the connector issued for a different offer', async () => {
    const connector = educationConnector();
    const real = connector.getQuote.bind(connector);
    connector.getQuote = async (offerId, request): Promise<Quote> => ({
      ...(await real(offerId, request)),
      offerId: 'mock-education:offer:somebody-else',
    });
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'price'),
      {
        kind: 'tools',
        toolCalls: [{ name: 'list_offers', input: { itemId: IELTS } }],
      },
      {
        kind: 'tools',
        toolCalls: [{ name: 'get_quote', input: { offerId: WEEKDAY } }],
      },
      { kind: 'tools', text: '{{F1}} operator narxni tasdiqlaydi.' },
    ]);
    const { result } = await runTurn({
      provider,
      text: 'IELTS narxi qancha?',
      connector,
    });
    expect(
      result.facts.some(
        (f) => f.value.kind === 'price' && f.provenance.live === true,
      ),
    ).toBe(false);
    expect(result.reply).not.toMatch(/\d/u);
  });

  it('shows a live quote and carries tenant, conversation and offer on its provenance', async () => {
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'price'),
      {
        kind: 'tools',
        toolCalls: [{ name: 'list_offers', input: { itemId: IELTS } }],
      },
      {
        kind: 'tools',
        toolCalls: [{ name: 'get_quote', input: { offerId: WEEKDAY } }],
      },
      { kind: 'tools', text: '{{F1}} narxi: {{F10}}.' },
    ]);
    const { result } = await runTurn({ provider, text: 'IELTS narxi qancha?' });
    expect(result.outcome).toBe('ANSWERED');
    expect(result.safety).toBeUndefined();
    expect(result.facts.find((f) => f.id === 'F10')?.provenance).toMatchObject({
      tenantId: 'tenant-eval',
      conversationId: 'conversation-eval',
      offerId: WEEKDAY,
      live: true,
    });
  });
});
