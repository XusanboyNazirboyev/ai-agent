/**
 * Simulated phone call over the fakes (ADR 045 latency harness). Real
 * adapters and the real turn engine plug in through the same ports later.
 */
import { INITIAL_LOCALE_PACKS } from '../locales/locale-packs.js';
import type { LocaleId } from '../core/locales/locale-pack.js';
import { CallOrchestrator, type CallSummary } from './call-orchestrator.js';
import {
  FakeStreamingResponder,
  FakeStreamingSpeechToText,
  FakeStreamingTextToSpeech,
  MockSipGateway,
  ScriptedCaller,
  type LatencyKnob,
} from './fakes.js';
import {
  buildLatencyReport,
  type LatencyBudget,
  type LatencyReport,
} from './latency-timeline.js';
import type { TurnResponder } from './ports.js';
import { VirtualClock } from './virtual-clock.js';

export interface LatencySimulationOptions {
  readonly turns?: number;
  readonly locale?: LocaleId;
  readonly sttFinal?: LatencyKnob;
  readonly llmFirstToken?: LatencyKnob;
  readonly ttsFirstByte?: LatencyKnob;
  readonly tokenIntervalMs?: number;
  readonly playoutLatencyMs?: number;
  readonly budget?: LatencyBudget;
  readonly seed?: number;
  /** Replaces the default fake streaming responder. */
  readonly responder?: (clock: VirtualClock) => TurnResponder;
}

export interface LatencySimulationResult {
  readonly summary: CallSummary;
  readonly report: LatencyReport;
}

export async function runLatencySimulation(
  options: LatencySimulationOptions = {},
): Promise<LatencySimulationResult> {
  const clock = new VirtualClock();
  const locale = options.locale ?? 'uz-Latn';
  const seed = options.seed ?? 7;
  const gateway = new MockSipGateway({
    clock,
    playoutLatencyMs: options.playoutLatencyMs ?? 40,
  });
  const stt = new FakeStreamingSpeechToText({
    clock,
    finalLatency: options.sttFinal ?? { baseMs: 140, jitterMs: 60 },
    seed,
  });
  const tts = new FakeStreamingTextToSpeech({
    clock,
    firstByteLatency: options.ttsFirstByte ?? { baseMs: 110, jitterMs: 50 },
    seed: seed + 1,
  });
  const responder =
    options.responder?.(clock) ??
    new FakeStreamingResponder({
      clock,
      firstTokenLatency: options.llmFirstToken ?? {
        baseMs: 320,
        jitterMs: 120,
      },
      tokenIntervalMs: options.tokenIntervalMs ?? 25,
      seed: seed + 2,
    });
  const pack = INITIAL_LOCALE_PACKS.find((p) => p.id === locale);
  if (!pack) throw new Error(`no locale pack ${locale}`);
  const orchestrator = new CallOrchestrator({
    clock,
    wallNow: (): Date => new Date('2026-11-10T07:00:00Z'), // 12:00 Asia/Tashkent
    gateway,
    stt,
    tts,
    responder,
    locale,
    voiceTemplates: pack.templates.voice,
    tenant: { timeZone: 'Asia/Tashkent', operatorNumber: '+998000000000' },
  });

  const callId = gateway.simulateInbound('+998901112233', '+998712000000');
  const leg = await gateway.acceptInbound(callId);
  const caller = new ScriptedCaller(clock, gateway.endpoint(callId));
  const call = orchestrator.handleCall(leg);
  const driver = (async (): Promise<void> => {
    await caller.waitForReply(); // consent prompt
    for (let i = 0; i < (options.turns ?? 20); i += 1) {
      await caller.say(`Savol ${i + 1}`, 500);
      await caller.waitForReply();
    }
    caller.hangUp();
  })();
  const [summary] = await clock.runUntil(Promise.all([call, driver]));
  return { summary, report: buildLatencyReport(summary.turns, options.budget) };
}
