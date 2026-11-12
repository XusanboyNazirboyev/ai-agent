# ADR 055: Spoken replies to voice notes (text-to-speech)

- **Status:** Proposed, 2026-11-12. Stage S1 built (port, adapters, policy, transcoder, config, tests); nothing is wired into message delivery.
- **Context:** Customers send voice notes (ADR 042, speech-to-text) and get text answers. The owner decided (2026-11-12) that the bot may answer a voice note with a voice note, in Russian and English, using VoxCPM2. Phone calls stay out of scope (ADR 045 parked). Uzbek replies stay text, because VoxCPM2 has no Uzbek. The streaming `StreamingTextToSpeech` port for calls (ADR 045) is unchanged; this ADR adds a separate one-shot `TextToSpeech` port.

## Decisions

1. **Port:** `TextToSpeech.synthesize({ text, language, signal? }) -> SpeechAudio { bytes, mimeType, sampleRateHz|null, durationMs|null }`, `supportsLanguage()`, typed `TtsError` (`UNSUPPORTED_LANGUAGE`, `PROVIDER_UNAVAILABLE`, `TIMEOUT`, `EMPTY_AUDIO`, `INVALID_RESPONSE`, plus `TEXT_TOO_LONG`, `EMPTY_TEXT`, `TRANSCODE_FAILED`, `AUDIO_TOO_LARGE`). Code lives in `apps/api/src/voice/tts/`.
2. **Provider:** a VoxCPM2 adapter for the vLLM-Omni OpenAI-compatible endpoint only. Languages exactly `ru` and `en` (prefix of the locale); everything else is `UNSUPPORTED_LANGUAGE` and stays text.
3. **Policy (pure, `decideSpeech`):** speak only when the channel is enabled for the tenant, the language is supported, the reply is non-empty and at most `TTS_MAX_CHARS` (600), and the reply carries no digits, currency symbols or words, percent, fact references (`{{F1}}`), URLs, e-mail addresses or handles. A spoken number may be misheard and the written text is the source of truth (AGENTS.md rules 2 and 8), so a reply that carries facts is never spoken in this stage.
4. **Sanitiser:** control and zero-width characters removed, whitespace collapsed, leading parenthesised groups removed (voice-instruction injection), length capped with an error, not truncation.
5. **Transcoding:** `ffmpeg` through `spawn` with an argument array (no shell, no interpolated input). Telegram: OGG/Opus 24 kbit/s mono 48 kHz (pipes). Instagram: AAC in M4A with `+faststart`, which needs a seekable output, so a random-named temp file in `os.tmpdir()` that is always deleted.
6. **Config (all off by default):** `TTS_PROVIDER=off|voxcpm`, `TTS_VOXCPM_BASE_URL`, `TTS_VOXCPM_MODEL` (`openbmb/VoxCPM2`), `TTS_VOXCPM_VOICE` (`default`), `TTS_VOXCPM_API_KEY` (optional secret), `TTS_TIMEOUT_MS` (20000), `TTS_MAX_CHARS` (600). `voxcpm` requires the base URL.
7. **Service:** `SpeechSynthesisService.speak()` applies the policy, synthesises, transcodes per channel, enforces channel size limits (Telegram 50 MB, Instagram 25 MB), never throws, and returns a metrics-friendly outcome (`SPOKEN`, `SKIPPED_*`, `FAILED_*`).

## Verified facts (read 2026-11-12)

- VoxCPM (https://github.com/OpenBMB/VoxCPM, README): Apache-2.0, 2B parameters, needs CUDA (about 8 GB VRAM), 30 languages including Russian and English, no Uzbek; the model table says 48 kHz. A voice description in the Python API is written in parentheses at the start of the text. The README documents no language field.
- vLLM-Omni recipe (https://github.com/vllm-project/vllm-omni/tree/main/examples/online_serving/voxcpm2): `vllm serve openbmb/VoxCPM2 --omni --port 8000`; `POST /v1/audio/speech` with JSON `{"model":"openbmb/VoxCPM2","input":"...","voice":"default"}` returns audio (the example saves `out.wav`). The response format and sample rate of this endpoint are not documented.
- Telegram `sendVoice` (https://core.telegram.org/bots/api#sendvoice): the audio must be OGG encoded with OPUS, or MP3, or M4A, otherwise it is sent as Audio or Document; limit 50 MB.
- Instagram messaging API (https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api): an `audio` attachment is supported; audio aac, m4a, wav, mp4, 25 MB; the file is given as a public `payload.url`; whether `attachment_id` upload works for audio is not stated; no maximum duration stated; 24-hour standard messaging window.

## Unverified (must be checked in S3 on a real server)

Response container and sample rate of `/v1/audio/speech`; the authorisation header scheme (the adapter sends `Authorization: Bearer`, the vLLM `--api-key` convention); whether a `response_format` field exists; real-time factor and latency on the chosen GPU; voice quality in Russian and English (the owner must listen); whether the same text always yields the same voice.

## Risks

- **Quality unknown** until the owner listens to samples; nothing is enabled before that.
- **GPU hosting cost** is not evaluated (about 8 GB VRAM, always-on or autoscaled).
- **Uzbek is not supported;** Uzbek customers keep getting text, so behaviour differs by language.
- **Numbers spoken aloud** may be misheard; hence the policy blocks any reply with figures. Rule 2 stays satisfied because no fact is rendered by the model or the voice.
- **Voice-instruction injection:** reply text starting with a parenthesis could steer the voice; sanitised, with a test.
- **Latency and RTF:** a synchronous synthesis plus ffmpeg adds seconds to a reply; timeout 20 s; S2 must send the text fallback on any failure.
- **Audio storage and public URL (Instagram):** the API needs a public URL, so S2 needs a short-lived signed URL, object storage or an authenticated route, and deletion after delivery.
- **Retention (ADR 049):** generated audio is derived from customer conversation content; it must be covered by the retention purge and by contact erasure, or not stored at all (Telegram multipart upload needs no storage). Nothing is stored in S1.
- **Provider secrets and logs:** text and audio are never logged; the API key is read from the environment only.

## Staged plan

- **S1 (this change):** port, fake, VoxCPM adapter, policy, transcoder, service, config, unit tests; nothing wired.
- **S2:** delivery wiring for Telegram (multipart `sendVoice`) and Instagram (short-lived signed public URL) behind a per-channel flag and per-tenant setting; text fallback on any failure; metering; retention coverage.
- **S3:** GPU hosting, measurement (RTF, latency, cost), real-server verification of the unverified items, owner listening test.

## Open decisions for the owner

1. **Text plus voice:** when a reply carries facts, should it be sent as text only (S1 default), or as text and a voice note that speaks only the non-fact sentences, or both in full? S1 never speaks a reply that carries facts.
2. Which channels and tenants get it first, and whether it applies only when the customer's message was a voice note (assumed yes).
3. GPU hosting budget and provider.
4. Whether generated audio may be stored at all (retention).
