import { describe, expect, it } from 'vitest';
import {
  OWNER_LATENCY_BUDGET,
  VoiceTurnTimeline,
  buildLatencyReport,
  formatLatencyReport,
  percentile,
} from './latency-timeline.js';

function turn(
  i: number,
  d: {
    stt: number;
    llm: number;
    sentence: number;
    tts: number;
    playback: number;
  },
): VoiceTurnTimeline {
  const t = new VoiceTurnTimeline(i);
  const t0 = 1000 * i;
  t.mark('callerEndOfSpeech', t0);
  t.mark('sttFinal', t0 + d.stt);
  t.mark('llmFirstToken', t0 + d.stt + d.llm);
  t.mark('firstSentenceReady', t0 + d.stt + d.llm + d.sentence);
  t.mark('ttsFirstAudio', t0 + d.stt + d.llm + d.sentence + d.tts);
  t.mark('playbackStart', t0 + d.stt + d.llm + d.sentence + d.tts + d.playback);
  return t;
}

describe('percentile', () => {
  it('uses nearest rank', () => {
    const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
  });
});

describe('VoiceTurnTimeline', () => {
  it('computes segments and end-to-end; first mark wins', () => {
    const t = turn(0, {
      stt: 150,
      llm: 300,
      sentence: 50,
      tts: 120,
      playback: 40,
    });
    t.mark('playbackStart', 99999);
    expect(t.segments()).toEqual({
      stt: 150,
      llm: 300,
      sentence: 50,
      tts: 120,
      playback: 40,
    });
    expect(t.endToEndMs()).toBe(660);
  });
  it('is incomplete until every stage is marked', () => {
    const t = new VoiceTurnTimeline(0);
    t.mark('callerEndOfSpeech', 0);
    expect(t.isComplete()).toBe(false);
    expect(t.endToEndMs()).toBeUndefined();
  });
});

describe('latency report', () => {
  it('passes inside the owner budget', () => {
    const turns = Array.from({ length: 10 }, (_, i) =>
      turn(i, {
        stt: 150,
        llm: 300 + i * 10,
        sentence: 50,
        tts: 120,
        playback: 40,
      }),
    );
    const report = buildLatencyReport(turns);
    expect(report.turns).toBe(10);
    expect(report.perStage.llm).toEqual({ p50: 340, p95: 390, max: 390 });
    expect(report.endToEnd.max).toBe(750);
    expect(report.verdict).toEqual({
      pass: true,
      reasons: [],
      blownStages: [],
    });
    expect(formatLatencyReport(report)).toContain('verdict: PASS');
  });

  it('fails and names the stage that blew the budget', () => {
    const turns = [
      ...Array.from({ length: 9 }, (_, i) =>
        turn(i, { stt: 150, llm: 300, sentence: 50, tts: 120, playback: 40 }),
      ),
      turn(9, { stt: 150, llm: 1100, sentence: 50, tts: 120, playback: 40 }),
    ];
    const report = buildLatencyReport(turns);
    expect(report.endToEnd.max).toBe(1460);
    // max is under the hard limit, p95 (nearest rank 10th of 10) is the slow turn
    expect(report.endToEnd.p95).toBe(1460);
    expect(report.verdict.pass).toBe(false);
    expect(report.verdict.blownStages).toEqual(['llm']);
    expect(report.verdict.reasons[0]).toContain('p95');
  });

  it('fails the hard limit and counts incomplete turns', () => {
    const slow = turn(0, {
      stt: 400,
      llm: 600,
      sentence: 100,
      tts: 300,
      playback: 200,
    });
    const partial = new VoiceTurnTimeline(1);
    partial.mark('callerEndOfSpeech', 0);
    const report = buildLatencyReport([slow, partial]);
    expect(report.incompleteTurns).toBe(1);
    expect(report.verdict.pass).toBe(false);
    expect(report.verdict.reasons.join(' ')).toContain(
      `hard limit ${OWNER_LATENCY_BUDGET.hardLimitMs}`,
    );
    expect(report.verdict.blownStages).toContain('stt');
  });

  it('does not pass with no measured turns', () => {
    expect(buildLatencyReport([]).verdict.pass).toBe(false);
  });
});
