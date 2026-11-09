/**
 * Energy-based voice-activity detection for caller audio (ADR 045 turn
 * taking). Pure and deterministic: one call per PCM frame.
 *
 * - The noise floor adapts during silence (slow moving average), so a line
 *   with steady background noise does not count as speech.
 * - Speech starts after `minSpeechMs` of consecutive voiced audio (a cough or
 *   a click does not barge in).
 * - The end of an utterance is declared after `endSilenceMs` of silence
 *   following speech; that frame carries `endOfUtterance` and commits the STT
 *   segment. A longer utterance gets a slightly shorter wait, as people pause
 *   less at the end of a long sentence than mid-way through a short one.
 */

export interface VadOptions {
  /** Absolute floor for speech, dBFS (default -45). */
  readonly minSpeechDbfs?: number;
  /** Margin above the adaptive noise floor, dB (default 12). */
  readonly marginDb?: number;
  readonly minSpeechMs?: number;
  readonly endSilenceMs?: number;
  /** End-silence wait after utterances longer than 3 s (default 450). */
  readonly endSilenceLongMs?: number;
}

export interface VadDecision {
  readonly speech: boolean;
  readonly endOfUtterance: boolean;
  readonly levelDbfs: number;
}

export function rmsDbfs(samples: Int16Array): number {
  if (samples.length === 0) return -120;
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / samples.length) / 32768;
  return rms <= 0 ? -120 : 20 * Math.log10(rms);
}

export class EnergyVad {
  private noiseFloor = -60;
  private voicedMs = 0;
  private silenceMs = 0;
  private inSpeech = false;
  private utteranceMs = 0;
  private readonly o: Required<VadOptions>;

  constructor(options: VadOptions = {}) {
    this.o = {
      minSpeechDbfs: options.minSpeechDbfs ?? -45,
      marginDb: options.marginDb ?? 12,
      minSpeechMs: options.minSpeechMs ?? 120,
      endSilenceMs: options.endSilenceMs ?? 600,
      endSilenceLongMs: options.endSilenceLongMs ?? 450,
    };
  }

  get speaking(): boolean {
    return this.inSpeech;
  }

  process(samples: Int16Array, durationMs: number): VadDecision {
    const level = rmsDbfs(samples);
    const threshold = Math.max(
      this.o.minSpeechDbfs,
      this.noiseFloor + this.o.marginDb,
    );
    const voiced = level >= threshold;

    if (voiced) {
      this.voicedMs += durationMs;
      this.silenceMs = 0;
    } else {
      this.voicedMs = 0;
      this.silenceMs += durationMs;
      // Adapt only on unvoiced audio, and never above the speech floor.
      this.noiseFloor = Math.min(
        this.o.minSpeechDbfs,
        this.noiseFloor * 0.95 + level * 0.05,
      );
    }

    if (!this.inSpeech && this.voicedMs >= this.o.minSpeechMs) {
      this.inSpeech = true;
      this.utteranceMs = this.voicedMs;
    } else if (this.inSpeech) {
      this.utteranceMs += durationMs;
    }

    let endOfUtterance = false;
    if (this.inSpeech && !voiced) {
      const wait =
        this.utteranceMs > 3_000
          ? this.o.endSilenceLongMs
          : this.o.endSilenceMs;
      if (this.silenceMs >= wait) {
        endOfUtterance = true;
        this.inSpeech = false;
        this.utteranceMs = 0;
      }
    }
    return {
      speech: this.inSpeech && voiced,
      endOfUtterance,
      levelDbfs: level,
    };
  }
}
