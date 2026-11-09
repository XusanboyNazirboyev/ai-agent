/**
 * Voice latency harness (ADR 045): runs a simulated call over fake adapters
 * on a virtual clock and prints the per-stage and end-to-end report. Real
 * adapters plug in through the same ports later. No network, no keys.
 *
 *   pnpm exec tsx scripts/voice-latency.ts [--turns 20] [--locale uz-Latn]
 *     [--stt-ms 140] [--llm-ms 320] [--tts-ms 110] [--playout-ms 40]
 *
 * Exit code 1 when the verdict is FAIL.
 */
import type { LocaleId } from '../src/core/locales/locale-pack.js';
import { runLatencySimulation } from '../src/voice/latency-simulation.js';
import { formatLatencyReport } from '../src/voice/latency-timeline.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function num(name: string, fallback: number): number {
  const v = arg(name);
  return v === undefined ? fallback : Number(v);
}

async function main(): Promise<void> {
  const jitter = (
    base: number,
    j: number,
  ): { baseMs: number; jitterMs: number } => ({ baseMs: base, jitterMs: j });
  const { report, summary } = await runLatencySimulation({
    turns: num('turns', 20),
    locale: (arg('locale') ?? 'uz-Latn') as LocaleId,
    sttFinal: jitter(num('stt-ms', 140), 60),
    llmFirstToken: jitter(num('llm-ms', 320), 120),
    ttsFirstByte: jitter(num('tts-ms', 110), 50),
    playoutLatencyMs: num('playout-ms', 40),
  });
  console.log(
    `call ${summary.callId}: ${summary.turns.length} turns, consent first: "${summary.spoken[0]}"`,
  );
  console.log(formatLatencyReport(report));
  process.exitCode = report.verdict.pass ? 0 : 1;
}

void main();
