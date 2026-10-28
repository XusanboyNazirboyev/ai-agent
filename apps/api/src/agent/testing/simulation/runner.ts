import type { LlmProvider } from '../../../core/llm/llm-provider.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { SimulatedCustomer, TranscriptEntry } from './customer.js';
import { gradeRun, runPasses, type RunMetrics } from './grader.js';
import type { Scenario, SimLanguage } from './scenario.js';
import { SimulationWorld } from './world.js';

export interface RunResult {
  readonly scenarioId: string;
  readonly pack: Scenario['pack'];
  readonly category: string;
  readonly language: SimLanguage;
  readonly run: number;
  /** `not_runnable`: v1 lacks what the scenario needs (reported as a failure). */
  readonly status: 'completed' | 'error' | 'not_runnable';
  readonly reason?: string;
  readonly endedBy?: string;
  readonly customerTurns: number;
  readonly passed: boolean;
  readonly metrics?: RunMetrics;
  readonly transcript: readonly TranscriptEntry[];
  readonly simulatorUsage: SimulatedCustomer['usage'];
  readonly clockShifts: number;
  /** The tenant this run created (absent when it failed before that). */
  readonly tenantId?: string;
}

/**
 * One run: the customer talks to the v1 agent until the customer ends, the
 * conversation leaves the bot (handover), or `maxTurns` customer turns.
 */
export async function runScenario(options: {
  db: PrismaClient;
  scenario: Scenario;
  language: SimLanguage;
  run: number;
  provider: LlmProvider;
  customer: SimulatedCustomer;
  settings: Record<string, unknown>;
}): Promise<RunResult> {
  const { scenario, language, customer } = options;
  const base = {
    scenarioId: scenario.id,
    pack: scenario.pack,
    category: scenario.category,
    language,
    run: options.run,
  };
  if (scenario.pack === 'retail')
    return {
      ...base,
      status: 'not_runnable',
      reason:
        'no retail pack in v1 (roadmap slice 3b; mock-only per decision 3)',
      customerTurns: 0,
      passed: false,
      transcript: [],
      simulatorUsage: customer.usage,
      clockShifts: 0,
    };

  const transcript: TranscriptEntry[] = [];
  const customerTexts: string[] = [];
  let world: SimulationWorld | undefined;
  let turnsToLead: number | undefined;
  let endedBy = 'max_turns';
  try {
    world = await SimulationWorld.create({
      db: options.db,
      scenario,
      language,
      provider: options.provider,
      settings: options.settings,
    });
    for (let turn = 1; turn <= scenario.maxTurns; turn += 1) {
      const move = await customer.next(transcript);
      if (move.kind === 'end') {
        endedBy = move.reason;
        break;
      }
      const replies =
        move.kind === 'say'
          ? await world.say(move.text)
          : await world.wait(move.hours);
      if (move.kind === 'say') {
        transcript.push({ from: 'customer', text: move.text });
        customerTexts.push(move.text);
      }
      for (const text of replies) transcript.push({ from: 'business', text });
      if (
        turnsToLead === undefined &&
        (await options.db.lead.count({ where: { tenantId: world.tenantId } })) >
          0
      )
        turnsToLead = customerTexts.length;
      const conversation = await options.db.conversation.findFirst({
        where: { tenantId: world.tenantId },
        select: { state: true },
      });
      if (conversation && conversation.state !== 'BOT_ACTIVE') {
        endedBy = `state_${conversation.state}`;
        break;
      }
    }
    const state = await world.state();
    const metrics = gradeRun({
      scenario,
      language,
      state,
      customerTexts,
      turnsToLead,
    });
    return {
      ...base,
      status: 'completed',
      tenantId: world.tenantId,
      endedBy,
      customerTurns: customerTexts.length,
      passed: runPasses(metrics),
      metrics,
      transcript,
      simulatorUsage: customer.usage,
      clockShifts: state.clockShifts,
    };
  } catch (error: unknown) {
    return {
      ...base,
      status: 'error',
      ...(world ? { tenantId: world.tenantId } : {}),
      reason:
        error instanceof Error ? error.message.slice(0, 300) : 'unknown error',
      customerTurns: customerTexts.length,
      passed: false,
      transcript,
      simulatorUsage: customer.usage,
      clockShifts: 0,
    };
  } finally {
    await world?.close();
  }
}
