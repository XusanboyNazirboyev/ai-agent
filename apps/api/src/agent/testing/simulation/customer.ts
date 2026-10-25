import { z } from 'zod';
import type { LlmProvider } from '../../../core/llm/llm-provider.js';
import type { Scenario, ScriptStep, SimLanguage } from './scenario.js';

/** One exchange of the conversation, as the customer saw it. */
export interface TranscriptEntry {
  readonly from: 'customer' | 'business';
  readonly text: string;
}

export type CustomerMove =
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'wait'; readonly hours: number }
  | { readonly kind: 'end'; readonly reason: string };

/** Token use of the simulator's own model calls (not the agent's). */
export interface SimulatorUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SimulatedCustomer {
  readonly kind: 'scripted' | 'llm';
  readonly usage: SimulatorUsage;
  next(transcript: readonly TranscriptEntry[]): Promise<CustomerMove>;
}

/** Plays the scenario's script for one language, then ends. Deterministic. */
export class ScriptedCustomer implements SimulatedCustomer {
  readonly kind = 'scripted' as const;
  readonly usage: SimulatorUsage = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  private index = 0;
  private readonly steps: readonly ScriptStep[];

  constructor(scenario: Scenario, language: SimLanguage) {
    const steps = scenario.script[language];
    if (!steps) throw new Error(`${scenario.id}: no script for ${language}`);
    this.steps = steps;
  }

  next(): Promise<CustomerMove> {
    const step = this.steps[this.index];
    this.index += 1;
    if (!step) return Promise.resolve({ kind: 'end', reason: 'script_done' });
    return Promise.resolve(
      'say' in step
        ? { kind: 'say', text: step.say }
        : { kind: 'wait', hours: step.wait.hours },
    );
  }
}

const LANGUAGE_NAME: Record<SimLanguage, string> = {
  'uz-Latn': 'Uzbek written in the Latin alphabet',
  'uz-Cyrl': 'Uzbek written in the Cyrillic alphabet',
  ru: 'Russian',
  en: 'English',
};

const MoveSchema = z.object({
  message: z.string().max(600),
  done: z.boolean(),
  reason: z.string().max(80),
});
const MOVE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'done', 'reason'],
  properties: {
    message: { type: 'string', maxLength: 600 },
    done: { type: 'boolean' },
    reason: { type: 'string', maxLength: 80 },
  },
} as const;

/**
 * A model plays the customer. The opening line is the script's first step, so
 * runs start identically; afterwards the model answers the business in the
 * persona's language until its goal is met, a person takes over, or patience
 * runs out. All data is synthetic (scenario files only).
 */
export class LlmCustomer implements SimulatedCustomer {
  readonly kind = 'llm' as const;
  readonly usage: SimulatorUsage = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  private opened = false;
  private readonly opening: ScriptStep;

  constructor(
    private readonly provider: LlmProvider,
    private readonly scenario: Scenario,
    private readonly language: SimLanguage,
  ) {
    const first = scenario.script[language]?.[0];
    if (!first) throw new Error(`${scenario.id}: no script for ${language}`);
    this.opening = first;
  }

  system(): string {
    const { persona } = this.scenario;
    return [
      'You are role-playing a customer who writes to a business in a messenger chat. This is a test with fictional data.',
      `Write ONLY in ${LANGUAGE_NAME[this.language]}.`,
      `Style: ${persona.style}; patience: ${persona.patience}${persona.typos ? '; you make occasional typos' : ''}.`,
      `Your goal: ${this.scenario.goal[this.language]}`,
      `What you know about yourself (share only when asked or when it is natural): ${this.scenario.facts[this.language]}`,
      'Rules: send ONE short messenger message per turn. Never say you are an AI, a test or a simulation. Do not invent needs beyond your goal. Do not repeat yourself word for word.',
      'Set done=true (with an empty or closing message) when your goal is met, when you are told a human colleague will take over, or when you have lost patience. reason: a few words why.',
    ].join('\n');
  }

  async next(transcript: readonly TranscriptEntry[]): Promise<CustomerMove> {
    if (!this.opened) {
      this.opened = true;
      return 'say' in this.opening
        ? { kind: 'say', text: this.opening.say }
        : { kind: 'wait', hours: this.opening.wait.hours };
    }
    const conversation = transcript
      .map(
        (entry) =>
          `${entry.from === 'customer' ? 'You' : 'Business'}: ${entry.text}`,
      )
      .join('\n');
    const result = await this.provider.generateStructured({
      tier: 'FAST',
      purpose: 'evaluate',
      system: this.system(),
      messages: [
        {
          role: 'user',
          text: `<conversation>\n${conversation}\n</conversation>\nWrite your next message.`,
        },
      ],
      maxOutputTokens: 300,
      schemaName: 'customer_move',
      jsonSchema: MOVE_JSON_SCHEMA,
      schema: MoveSchema,
    });
    this.usage.calls += 1;
    this.usage.inputTokens += result.usage.inputTokens;
    this.usage.outputTokens += result.usage.outputTokens;
    const move = result.value;
    if (!move)
      return { kind: 'end', reason: `simulator_${result.failure ?? 'failed'}` };
    if (move.done || !move.message.trim())
      return { kind: 'end', reason: move.reason || 'done' };
    return { kind: 'say', text: move.message.trim() };
  }
}
