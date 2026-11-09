/**
 * Live check of the voice turn engine (ADR 045 slice 3, step 2) on the
 * configured voice model (default: free `groq`), with the mock education
 * connector and the real tools, fact store, metering and spoken guardrail.
 * Synthetic caller lines only; no customer data, no audio.
 *
 *   pnpm exec tsx --env-file=<path to .env> scripts/voice-turn-live.ts \
 *     [--pause-ms 0]
 *
 * `--pause-ms` waits between turns (free tiers limit tokens per minute).
 *
 * Env: VOICE_LLM_PRESET / VOICE_LLM_MODEL (optional) and the preset's key
 * variable (e.g. GROQ_API_KEY). Values are never printed.
 *
 * Prints, per caller line: what would be spoken, the filler, a handover,
 * time to the first speakable event and to the first answer sentence.
 * Exit code 1 when a turn fails a check stated next to it.
 */
import { performance } from 'node:perf_hooks';
import {
  educationConnector,
  LOCALES,
  TEST_LIMITS,
} from '../src/agent/testing/agent-harness.js';
import { displayPolicyFor } from '../src/core/agent/display-gate.js';
import { FactStore } from '../src/core/agent/facts.js';
import { AgentTools } from '../src/core/agent/tools.js';
import { TurnBudget } from '../src/core/llm/budget.js';
import { MeteredLlm } from '../src/core/llm/metered-llm.js';
import type { LocaleId } from '../src/core/locales/locale-pack.js';
import { PRICING_CATALOG } from '../src/llm/pricing-catalog.js';
import { EDUCATION_PACK } from '../src/packs/education/education.pack.js';
import type { Clock, ResponderEvent } from '../src/voice/ports.js';
import { createVoiceLlmProvider } from '../src/voice/voice-llm.js';
import {
  VoiceTurnEngine,
  type VoiceTurnResources,
} from '../src/voice/voice-turn-engine.js';

interface Line {
  readonly locale: LocaleId;
  readonly text: string;
  /** What the turn must do; checked after it ends. */
  readonly expect: 'answer' | 'handover' | 'either';
}

const CALL: readonly Line[] = [
  { locale: 'uz-Latn', text: 'Assalomu alaykum.', expect: 'answer' },
  { locale: 'uz-Latn', text: 'IELTS kursi bormi?', expect: 'answer' },
  { locale: 'uz-Latn', text: 'Uning narxi qancha?', expect: 'either' },
  {
    locale: 'uz-Latn',
    text: 'Sizlarning telefon raqamingiz va telegramingiz qanaqa?',
    expect: 'either',
  },
  {
    locale: 'uz-Latn',
    text: 'Menga operator bilan gaplashish kerak.',
    expect: 'handover',
  },
];
const RU_CALL: readonly Line[] = [
  {
    locale: 'ru',
    text: 'Здравствуйте, есть курс английского?',
    expect: 'answer',
  },
];

const usage = { calls: 0, input: 0, output: 0 };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const clock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

async function runCall(lines: readonly Line[], label: string): Promise<number> {
  const { provider, config } = createVoiceLlmProvider(process.env);
  const pricing = PRICING_CATALOG.snapshot('routing-free-2026-10-23');
  const connector = educationConnector();
  const scope = {
    tenantId: 'tenant-eval',
    conversationId: `voice-live-${label}`,
  };
  const engine = new VoiceTurnEngine({
    pack: EDUCATION_PACK,
    locales: LOCALES,
    timeZone: 'Asia/Tashkent',
    scope,
    // As a text turn: derived from what the connector can do live.
    displayPolicy: displayPolicyFor(connector.capabilities),
    clock,
    fillerAfterMs: 900,
    onDiagnostic: (d): void =>
      console.log(
        d.kind === 'blocked'
          ? `     blocked  [${d.violations.join(', ')}] ${d.sentence}`
          : `     llm error ${d.code}`,
      ),
    beginTurn: (input): VoiceTurnResources => {
      const budget = new TurnBudget(
        { ...TEST_LIMITS, maxTurnTokens: 40_000 },
        { conversationSpentNano: 0, tenantMonthSpentNano: 0 },
      );
      const facts = new FactStore();
      const llm = new MeteredLlm(
        provider,
        pricing,
        budget,
        {
          record: (entry): Promise<void> => {
            usage.calls += 1;
            usage.input +=
              entry.usage.inputTokens + entry.usage.cacheReadTokens;
            usage.output += entry.usage.outputTokens;
            return Promise.resolve();
          },
        },
        { tenantId: scope.tenantId, turnKey: `${label}:${input.turnIndex}` },
      );
      const tools = new AgentTools({
        connector,
        pack: EDUCATION_PACK,
        facts,
        budget,
        timeoutMs: 5_000,
        now: (): Date => new Date(),
        scope,
      });
      return { llm, tools, facts };
    },
  });
  console.log(`\n=== ${label}: ${config.presetId} ${config.model}`);
  let failures = 0;
  const pause = Number(arg('pause-ms') ?? 0);
  for (const [turnIndex, line] of lines.entries()) {
    if (turnIndex > 0 && pause > 0) await clock.sleep(pause);
    usage.calls = 0;
    usage.input = 0;
    usage.output = 0;
    const started = performance.now();
    let firstEventMs: number | undefined;
    let firstSentenceMs: number | undefined;
    const events: ResponderEvent[] = [];
    for await (const event of engine.respond(
      { callId: label, locale: line.locale, transcript: line.text, turnIndex },
      new AbortController().signal,
    )) {
      const at = performance.now() - started;
      firstEventMs ??= at;
      if (event.type === 'sentence') firstSentenceMs ??= at;
      events.push(event);
    }
    const handover = events.find((e) => e.type === 'handover');
    const answered = events.some((e) => e.type === 'sentence');
    const ok =
      line.expect === 'either' ||
      (line.expect === 'answer' ? answered && !handover : Boolean(handover));
    if (!ok) failures += 1;
    console.log(
      `\n${ok ? 'ok  ' : 'FAIL'} caller: ${line.text}\n     first event ${firstEventMs?.toFixed(0) ?? '-'} ms, first sentence ${firstSentenceMs?.toFixed(0) ?? '-'} ms, ${usage.calls} LLM calls, ${usage.input} input / ${usage.output} output tokens`,
    );
    for (const e of events)
      console.log(
        `     ${e.type.padEnd(8)} ${e.type === 'handover' ? e.reason : e.text}`,
      );
  }
  return failures;
}

async function main(): Promise<void> {
  const failures = (await runCall(CALL, 'uz')) + (await runCall(RU_CALL, 'ru'));
  if (failures > 0) {
    console.log(`\n${failures} turn check(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? `${error.name}: ${error.message}` : 'failed',
  );
  process.exitCode = 1;
});
