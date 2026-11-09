import { describe, expect, it } from 'vitest';
import { INITIAL_LOCALE_PACKS } from '../locales/locale-packs.js';
import { runLatencySimulation } from './latency-simulation.js';

describe('latency harness', () => {
  it('passes with healthy fake latencies', async () => {
    const { report, summary } = await runLatencySimulation({ turns: 8 });
    expect(summary.turns).toHaveLength(8);
    expect(report.turns).toBe(8);
    expect(report.endToEnd.max).toBeLessThanOrEqual(1500);
    expect(report.verdict.pass).toBe(true);
  });

  it('fails and blames the LLM stage when first-token latency is high', async () => {
    const { report } = await runLatencySimulation({
      turns: 8,
      llmFirstToken: { baseMs: 1300, jitterMs: 100 },
    });
    expect(report.verdict.pass).toBe(false);
    expect(report.verdict.blownStages[0]).toBe('llm');
    expect(report.endToEnd.max).toBeGreaterThan(1500);
  });

  it('is deterministic for a seed', async () => {
    const a = await runLatencySimulation({ turns: 4, seed: 11 });
    const b = await runLatencySimulation({ turns: 4, seed: 11 });
    expect(a.report.endToEnd).toEqual(b.report.endToEnd);
  });
});

describe('voice locale templates (ADR 045)', () => {
  it('has all four phrases in every pack, uz-Latn consent is the owner text', () => {
    for (const pack of INITIAL_LOCALE_PACKS) {
      const v = pack.templates.voice;
      for (const text of Object.values(v))
        expect(text.length).toBeGreaterThan(5);
    }
    const uz = INITIAL_LOCALE_PACKS.find((p) => p.id === 'uz-Latn')!;
    expect(uz.templates.voice.consentPrompt).toBe(
      'Sifatni oshirish va xavfsizlik maqsadida suhbat yozib olinadi.',
    );
  });
});
