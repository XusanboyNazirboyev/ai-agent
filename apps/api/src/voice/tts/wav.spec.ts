import { describe, expect, it } from 'vitest';
import { buildWav, isWav, parseWav } from './wav.js';

describe('wav helpers', () => {
  it('builds a WAV that parses back to its rate and duration', () => {
    const wav = buildWav(48_000, 4800);
    expect(isWav(wav)).toBe(true);
    expect(parseWav(wav)).toEqual({ sampleRateHz: 48_000, durationMs: 100 });
  });

  it('rejects non-WAV and truncated input', () => {
    expect(isWav(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(
      parseWav(new TextEncoder().encode('OggS-not-wav-at-all')),
    ).toBeNull();
    expect(parseWav(buildWav(16_000, 10).subarray(0, 20))).toBeNull();
  });

  it('uses the bytes present when a streamed header has size 0', () => {
    const wav = buildWav(16_000, 1600);
    new DataView(wav.buffer).setUint32(40, 0, true);
    expect(parseWav(wav)?.durationMs).toBe(100);
  });
});
