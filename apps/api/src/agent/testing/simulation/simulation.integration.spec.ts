import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ScriptedLlmProvider,
  type ScriptStep,
} from '../../../core/llm/scripted-llm-provider.js';
import { PrismaClient } from '../../../generated/prisma/client.js';
import { createPostgresAdapter } from '../../../persistence/postgres-adapter.js';
import type { PrismaService } from '../../../persistence/prisma.service.js';
import { DiagnosticsPurgeService } from '../../diagnostics-purge.service.js';
import { extraction } from '../agent-harness.js';
import { EVAL_PACKS } from '../eval-runner.js';
import { ScriptedCustomer } from './customer.js';
import { runScenario } from './runner.js';
import { loadScenarios, type Scenario, type SimLanguage } from './scenario.js';
import { SimulationWorld, simulationSettings } from './world.js';
import { TelegramModule } from '../../../channels/telegram/telegram.module.js';
import { LeadsModule } from '../../../leads/leads.module.js';
import { LeadService } from '../../../leads/lead.service.js';
import { LeadSyncService } from '../../../leads/lead-sync.service.js';
import { ShownOffersService } from '../../../leads/shown-offers.service.js';
import { ScriptedLlmProvider as Scripted } from '../../../core/llm/scripted-llm-provider.js';

/**
 * The harness end to end through the real v1 pipeline with a scripted model
 * and the scripted customer (no network). Uses only the TEST_ database, which
 * must be a dedicated agentcore_* database and never the development one.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
const database = process.env.TEST_POSTGRES_DATABASE ?? '';
if (
  !/^agentcore_[a-z0-9_]+$/u.test(database) ||
  database === process.env.POSTGRES_DATABASE
)
  throw new Error('requires a dedicated agentcore_* test database');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
afterAll(async () => db.$disconnect());

const scenarios = loadScenarios(resolve(process.cwd(), '../../eval/scenarios'));
const byId = (id: string): Scenario => scenarios.find((s) => s.id === id)!;
const pack = EVAL_PACKS.education;

async function run(
  scenario: Scenario,
  language: SimLanguage,
  script: ScriptStep[],
): ReturnType<typeof runScenario> {
  return runScenario({
    db,
    scenario,
    language,
    run: 1,
    provider: new ScriptedLlmProvider(script),
    customer: new ScriptedCustomer(scenario, language),
    settings: simulationSettings(),
  });
}

describe('simulation harness on the v1 pipeline (scripted model)', () => {
  it('grades a grounded recommendation as passed', async () => {
    const result = await run(byId('edu-03'), 'en', [
      extraction({ subject: 'IELTS' }, 'price', 'en', 'Latn', pack),
      { kind: 'tools', text: 'The {{F1}} course is a good fit for you.' },
    ]);
    expect(result.status).toBe('completed');
    expect(result.metrics).toMatchObject({
      inventedFacts: [],
      falseSuccessClaims: 0,
      goalCompleted: true,
    });
    expect(result.metrics!.languageMatched).toBe(
      result.metrics!.languageChecked,
    );
    expect(result.passed).toBe(true);
    expect(result.transcript.map((t) => t.from)).toEqual([
      'customer',
      'business',
    ]);
  });

  it('ends on handover and checks its reason', async () => {
    const result = await run(byId('edu-22'), 'en', [
      extraction({}, 'human_request', 'en', 'Latn', pack),
    ]);
    expect(result.endedBy).toBe('state_WAITING_OPERATOR');
    expect(result.metrics?.handoverCorrect).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('stores redacted blocked-draft diagnostics on the turn, and the purge clears them (ADR 029)', async () => {
    const started = new Date();
    const result = await run(byId('edu-03'), 'en', [
      extraction({ subject: 'IELTS' }, 'price', 'en', 'Latn', pack),
      {
        kind: 'tools',
        text: 'It is 99 USD from 18:00; call +998 90 123 45 67.',
      },
      { kind: 'tools', text: 'It is 99 USD.' },
    ]);
    expect(result.metrics?.handoverReasons).toContain('GUARDRAIL');
    const where = {
      tenant: { slug: { startsWith: 'sim-edu-03-en-' } },
      createdAt: { gte: started },
      handoverReason: 'GUARDRAIL',
    };
    const turn = await db.agentTurn.findFirstOrThrow({
      where,
      orderBy: { createdAt: 'desc' },
      select: { id: true, diagnostics: true, diagnosticsExpiresAt: true },
    });
    const stored = JSON.stringify(turn.diagnostics);
    expect(stored).toContain('"stage":"first"');
    expect(stored).toContain('"stage":"regeneration"');
    expect(stored).toContain('"class":"time"');
    expect(stored).toContain('"class":"price"');
    expect(stored).not.toMatch(/90 123 45 67|998901234567/u);
    const days =
      (turn.diagnosticsExpiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);

    await new DiagnosticsPurgeService(db as unknown as PrismaService).scanDue(
      new Date(Date.now() + 15 * 86_400_000),
    );
    const purged = await db.agentTurn.findUniqueOrThrow({
      where: { id: turn.id },
      select: { diagnostics: true, diagnosticsExpiresAt: true, outcome: true },
    });
    expect(purged).toEqual({
      diagnostics: null,
      diagnosticsExpiresAt: null,
      outcome: 'HANDOVER',
    });
  });

  it('runs a confirmed business action through to a connector-confirmed lead', async () => {
    const base = byId('edu-19');
    const scenario: Scenario = {
      ...base,
      setup: { ...base.setup, contact: { phone: '+998901234567' } },
      script: {
        en: [{ say: 'IELTS, mornings, I want to enrol' }, { say: 'yes' }],
      },
    };
    const result = await run(scenario, 'en', [
      extraction(
        { subject: 'IELTS', preferredTime: 'morning' },
        'booking_interest',
        'en',
        'Latn',
        pack,
      ),
    ]);
    expect(result.status).toBe('completed');
    expect(result.metrics?.goalCompleted).toBe(true);
    expect(result.metrics?.falseSuccessClaims).toBe(0);
  });

  // DEF-001 (slice 1b-i): with the processor wired as in production
  // (ShownOffersService, LeadService, LeadSyncService), a delivered live-quote
  // answer records a ShownOffer and the follow-up fires. The earlier "no
  // follow-up" result came from the harness leaving those services out.
  it('follows up after a quoted price, as production does (DEF-001 was a harness wiring gap)', async () => {
    const started = new Date();
    const result = await run(byId('edu-30'), 'ru', [
      extraction(
        { subject: 'IELTS', preferredTime: 'evening' },
        'price',
        'ru',
        'Cyrl',
        pack,
      ),
      // The v1 price path (as in eval case edu-en-03): offers, then a live quote.
      {
        kind: 'tools',
        toolCalls: [
          {
            name: 'list_offers',
            input: { itemId: 'mock-education:edu-ielts-001' },
          },
        ],
      },
      {
        kind: 'tools',
        toolCalls: [
          {
            name: 'get_quote',
            input: { offerId: 'mock-education:offer:ielts-group-weekday' },
          },
        ],
      },
      { kind: 'tools', text: 'Курс {{F1}} стоит {{F10}}.' },
    ]);
    expect(result.status).toBe('completed');
    expect(result.metrics?.inventedFacts).toEqual([]);
    expect(result.metrics?.falseSuccessClaims).toBe(0);
    expect(result.transcript).toHaveLength(3); // answer, then the follow-up
    expect(result.transcript[1]?.text).toContain('150');
    expect(result.transcript[2]?.from).toBe('business');
    expect(result.metrics?.goalCompleted).toBe(true);
    expect(result.passed).toBe(true);
    const shown = await db.shownOffer.findMany({
      where: {
        tenant: { slug: { startsWith: 'sim-edu-30-ru-' } },
        shownAt: { gte: started },
      },
      select: { offerRef: true },
    });
    expect(shown.map((row) => row.offerRef)).toContain(
      'mock-education:offer:ielts-group-weekday',
    );
  });

  it('wires the processor with the collaborators production provides (no harness drift)', async () => {
    // Production: TelegramModule imports LeadsModule, which provides these.
    expect(Reflect.getMetadata('imports', TelegramModule)).toContain(
      LeadsModule,
    );
    expect(Reflect.getMetadata('providers', LeadsModule)).toEqual(
      expect.arrayContaining([
        LeadService,
        LeadSyncService,
        ShownOffersService,
      ]),
    );
    const world = await SimulationWorld.create({
      db,
      scenario: byId('edu-03'),
      language: 'en',
      provider: new Scripted([]),
      settings: simulationSettings(),
    });
    try {
      const processor = (
        world as unknown as { processor: Record<string, unknown> }
      ).processor;
      expect(processor.shownOffers).toBeInstanceOf(ShownOffersService);
      expect(processor.leads).toBeInstanceOf(LeadService);
      expect(processor.leadSync).toBeInstanceOf(LeadSyncService);
      expect(processor.agent).toBeDefined();
      expect(processor.actions).toBeDefined();
      // Not wired on purpose: the world never delivers handover.* events.
      expect(processor.handovers).toBeUndefined();
    } finally {
      await world.close();
    }
  });

  it('reports retail as not runnable on v1 instead of skipping it', async () => {
    const result = await run(byId('retail-01'), 'en', []);
    expect(result.status).toBe('not_runnable');
    expect(result.passed).toBe(false);
  });
});
