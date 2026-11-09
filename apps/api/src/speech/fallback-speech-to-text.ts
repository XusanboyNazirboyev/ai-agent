import type {
  AudioClip,
  SpeechToText,
  TranscriptionResult,
} from '../core/speech/speech-to-text.js';

/**
 * Voice-note STT with a backup provider (ADR 042, owner 2026-11-09: use the
 * ElevenLabs key too). The primary (Gemini, the best measured) answers; only
 * when it fails to answer at all (PROVIDER_ERROR, TIMEOUT) is the backup
 * asked, with a default language because ElevenLabs' automatic language
 * detection mislabelled Uzbek as Turkish in the measurement. Silence
 * (UNINTELLIGIBLE) and a refused clip keep the primary verdict: no second
 * paid call for audio that has nothing to hear.
 *
 * Metering: the wrapper reports the primary's token pricing; a backup answer
 * carries no token usage, so the worst case reserved for the note stays
 * counted (the reservation covers both calls at the default per-minute
 * worst case).
 */
export class FallbackSpeechToText implements SpeechToText {
  readonly providerId: string;
  readonly model: string;
  readonly pricing: SpeechToText['pricing'];

  constructor(
    private readonly primary: SpeechToText,
    private readonly backup: SpeechToText,
    /** Language the backup is told to expect when no hint is given. */
    private readonly backupLanguage: string,
  ) {
    this.providerId = `${primary.providerId}+${backup.providerId}`;
    this.model = `${primary.model}+${backup.model}`;
    this.pricing = primary.pricing;
  }

  async transcribe(
    clip: AudioClip,
    options: { languageHint?: string; signal?: AbortSignal } = {},
  ): Promise<TranscriptionResult> {
    const first = await this.primary.transcribe(clip, options);
    if (
      first.ok ||
      (first.code !== 'PROVIDER_ERROR' && first.code !== 'TIMEOUT')
    )
      return first;
    if (options.signal?.aborted) return first;
    return this.backup.transcribe(clip, {
      ...options,
      languageHint: options.languageHint ?? this.backupLanguage,
    });
  }
}
