# ADR 045: Voice calls over SIP with LiveKit

- **Status:** Accepted (owner decisions 2026-11-09, open items answered the same day). Every vendor sits behind a port. Not implemented.
- **Context:** owner Stage 2: an AI voice agent on real phone lines, inbound (24/7 virtual receptionist) and outbound (speed-to-lead call-back, appointment reminders). Voice calls were not in the spec; this ADR adds them.

## Owner decisions (2026-11-09)

1. Telephony: standard SIP trunking (PSTN / SIP URI), to connect Uzbek carriers (Evo, Beeline Business, Uztelecom). Both directions.
2. Media: LiveKit SIP + LiveKit Agents (LiveKit Cloud or self-hosted).
3. Speech: STT Deepgram Nova-2/3 or Gemini Live; TTS Cartesia Sonic or ElevenLabs. End-to-end response latency 0.7–1.2 s, never above 1.5 s.
4. Billing: audio is metered on the tenant LLM budget ledger (REV-03, ADR 042 amendment).
5. Recording: a consent prompt at call start, recordings stored encrypted in S3.

## Facts from vendor docs (read 2026-11-09)

| Vendor                                        | Uzbek                                                                                                                                                       | Russian | Source                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------- |
| Deepgram Nova-3 / Nova-2 (STT)                | **not listed**                                                                                                                                              | yes     | https://developers.deepgram.com/docs/models-languages-overview  |
| Cartesia Sonic 3.6 (TTS, 44 languages)        | **not listed**                                                                                                                                              | yes     | https://docs.cartesia.ai/build-with-cartesia/tts-models/latest  |
| ElevenLabs `eleven_v4_turbo` (TTS, ~100 ms)   | yes (`uz`)                                                                                                                                                  | yes     | https://elevenlabs.io/docs/overview/models                      |
| ElevenLabs `eleven_flash_v2_5` (TTS, ~100 ms) | no                                                                                                                                                          | yes     | same                                                            |
| ElevenLabs Scribe v2 Realtime (STT, ~150 ms)  | yes (`uzb`, "Good" tier, >10% to ≤20% WER for Scribe v2)                                                                                                    | yes     | https://elevenlabs.io/docs/overview/capabilities/speech-to-text |
| Gemini Live API                               | "70 supported languages"; Uzbek **not confirmed** on the page read                                                                                          | n/a     | https://aistudio.google.com/docs/live-api                       |
| LiveKit telephony                             | "designed to work with all SIP providers"; tested list does not name Uzbek carriers; inbound trunk + dispatch rule, outbound trunk + `CreateSIPParticipant` |         | https://docs.livekit.io/sip/                                    |

Consequence: the owner's STT options (Deepgram, Gemini Live) and the first TTS option (Cartesia) cannot serve Uzbek, the main locale (D17). Only ElevenLabs is verified for Uzbek in both directions.

## Design

1. **Ports, not vendors:** `StreamingSpeechToText` and `StreamingTextToSpeech` in `apps/api/src/voice/` (channel code, not `core/`), selected per locale. Proposal (OPEN-V1): ElevenLabs Scribe v2 Realtime + `eleven_v4_turbo` for `uz-Latn`/`uz-Cyrl`; Deepgram + Cartesia allowed for `ru`/`en` only if the owner wants a second vendor.
2. **Channel:** `voice` is a channel type like Telegram/Instagram (D6). A call is a conversation; each final caller utterance is an inbound message; the bot's reply is an outbound message rendered to audio. Handover (D11/D12): "operator" = SIP transfer to a tenant number (OPEN-V4).
3. **Turn engine for voice:** the current text turn (extract + respond, p50 ≈ 8 s, tool turns 12–25 s, PROGRESS P5) cannot meet 1.5 s. Voice needs a single streaming LLM call with tools, code-rendered facts streamed to TTS sentence by sentence, and a filler phrase when a tool call runs. Facts stay code-rendered (D5): the model never speaks a number it did not get from a tool. This is the largest risk of Stage 2 and is measured before any tenant goes live.
4. **Recording:** consent prompt from the locale pack before anything else is said: uz-Latn "Sifatni oshirish va xavfsizlik maqsadida suhbat yozib olinadi." (owner text, spelling corrected); ru/en/uz-Cyrl translated and native-reviewed (D18). Recording via LiveKit egress to an encrypted S3 bucket (SSE-KMS), retention per tenant (OPEN-V5).
5. **Outbound:** only to contacts who gave a phone number to this tenant and did not opt out; call windows (local time) and a per-tenant daily cap. Speed-to-lead and reminders are queue jobs (BullMQ, D7) with idempotency per lead / booking.
6. **Metering:** STT/TTS seconds and LLM tokens reserved on the tenant budget ledger before a call is answered or placed; a call that cannot be afforded is not started (inbound: transfer or polite refusal).

## Owner answers to the open items (2026-11-09, second decision)

- **V1:** Uzbek = ElevenLabs (STT Scribe v2 Realtime, TTS `eleven_v4_turbo`). Deepgram Nova-2/3 and Cartesia Sonic 3.6 are kept as fallback adapters for `ru`/`en` only. The streaming single-LLM-call turn engine with sentence-by-sentence TTS and D5 guardrails is approved.
- **V2:** LiveKit Cloud first; the adapter keeps the server URL and keys configurable so a self-hosted LiveKit server can replace it.
- **V3:** a standard SIP trunk adapter (PSTN / SIP URI). Tests use a mock SIP endpoint and a WebRTC test client; a real carrier comes later.
- **V4:** during working hours (09:00–18:00, tenant time) a SIP call transfer to the tenant's operator number; outside them a voicemail / callback request is created (a lead task for operators).
- **V5:** recordings in an encrypted S3 bucket, kept 90 days, playable only by OWNER and ADMIN roles. The S3 provider/region is still to be named at deployment (data residency).
- **V6:** outbound calls only 09:00–19:00 tenant time, a per-tenant daily cap, and only to customers who asked for a call-back (opt-in lead callback).

Still to verify from official docs at implementation (rule 7): `@livekit/agents` Node package and version, LiveKit egress-to-S3 options, ElevenLabs realtime STT/TTS streaming endpoints, model ids and prices.

## Order

Ports + fakes + latency harness first (no vendor keys needed); then the vendor adapters once V1–V3 are answered; then a staging call on a test number; no tenant goes live before the latency and WER checks pass.

## Implementation notes (slice 1)

Slice 1 (branch `feat/voice-ports`) adds ports, fakes, the latency harness and a minimal orchestrator in `apps/api/src/voice/`. No vendor SDK, network call, dependency or key.

- **Ports** (`ports.ts`): `StreamingSpeechToText` / `SttSession` (push frames, partial and final transcripts with timestamps), `StreamingTextToSpeech` / `TtsSession` (sentence in, timestamped audio chunks out, `cancel()` for barge-in), `TelephonyGateway` + `CallLeg` (accept, place, transfer, hang up, call events), `CallRecordingStore` (put with retention date, signed playback), `TurnResponder` (the seam where the streaming LLM turn engine plugs in; emits text deltas or a handover request), `Clock` (injectable).
- **Routing** (`provider-registry.ts`): V1 as config strings. Uzbek locales: ElevenLabs `scribe_v2_realtime` / `eleven_v4_turbo` only. ru/en: ElevenLabs first, Deepgram (`nova-3`) STT and Cartesia (`sonic-3.6`) TTS as fallbacks. A locale-support table filters candidates, so Deepgram and Cartesia can never serve Uzbek even if misconfigured (`validateRouting` reports it). Model ids are unverified config defaults until the adapters are written (rule 7).
- **Fakes** (`fakes.ts`): fake STT/TTS/streaming responder with seeded, configurable latency and jitter; `MockSipGateway` (inbound, outbound, transfer, hang-up, `injectFailure`); `ScriptedCaller` (WebRTC-test-client equivalent: speaks scripted utterances as fake frames, records what it hears with far-end playback times); `InMemoryRecordingStore`. A `VirtualClock` makes all waiting virtual, so no unit test sleeps.
- **Latency harness** (`latency-timeline.ts`, `latency-simulation.ts`, `scripts/voice-latency.ts`): `VoiceTurnTimeline` stages (caller end-of-speech, STT final, LLM first token, first sentence ready, TTS first audio, playback start); report gives p50/p95/max per segment and end-to-end. Verdict: FAIL when end-to-end p95 > 1200 ms (target), any turn > 1500 ms (hard limit), or a turn never reached first audio; blown stages are the segments whose p95 exceeds their soft allowance (stt 250, llm 400, sentence 250, tts 200, playback 100 ms; initial allowances, to be tuned on real adapters). Run: `pnpm exec tsx scripts/voice-latency.ts [--turns N --llm-ms M ...]`; exit code 1 on FAIL.
- **Orchestrator** (`call-orchestrator.ts`): consent prompt first and not interruptible; then utterance -> responder -> sentence-by-sentence TTS (producer/consumer, so sentence 2 is generated while sentence 1 plays); barge-in aborts the turn, cancels TTS and clears playback; handover decided by policy, with a failed transfer falling back to a callback request.
- **Policies** (`policies.ts`, pure): handover = transfer 09:00-18:00 tenant time else a typed `CALLBACK_REQUEST` decision (persistence later); outbound only 09:00-19:00, under a daily cap, with a callback opt-in and no opt-out, refusal reasons typed; recording retention 90 days; playback OWNER/ADMIN only.
- **Locale pack**: new `templates.voice` (`consentPrompt`, `oneMoment`, `transferNotice`, `afterHoursCallback`) in all four packs. The uz-Latn consent text is the owner's; ru/en/uz-Cyrl wording needs native review (D18).

Not done in slice 1 (open): the `oneMoment` filler is not yet spoken by the orchestrator (needs a tool-call signal from the real turn engine); audio metering on the budget ledger (ADR 042 amendment); persistence of callback requests and call records; BullMQ outbound jobs; all vendor adapters (ElevenLabs, Deepgram, Cartesia, LiveKit SIP, S3 egress) and verification of their endpoints, model ids and prices; the allowances above are unmeasured guesses against real providers.

## Implementation notes (slice 2: real adapters, 2026-11-09)

Branch `feat/voice-adapters` (stacked on `feat/voice-ports`). Code in `apps/api/src/voice/adapters/` and `apps/api/src/voice/metering.ts`; not wired into a Nest module, webhook route or call flow yet.

- **ElevenLabs** (`elevenlabs.ts`): `ElevenLabsRealtimeStt` = Scribe v2 Realtime WebSocket (`/v1/speech-to-text/realtime`, `model_id=scribe_v2_realtime`, `audio_format=pcm_16000`, `language_code=uz|ru|en`, `commit_strategy=manual`: the telephony VAD's end-of-utterance frame commits). `ElevenLabsDialogueTts` = `eleven_v4_turbo` on the Text to Dialogue WebSocket (`/v1/text-to-dialogue/stream-input`), the only socket that accepts v3/v4 models; one warm socket per call, one flushed input per sentence, a sentence ends on `is_final_audio_for_turn`; barge-in closes the socket and pre-warms a new one; keep-alive every 15 s. Auth by `xi-api-key` header, never in a URL. Docs read 2026-11-09: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime, https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket, https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd, https://elevenlabs.io/docs/overview/models. Verified live with the project key the same day: `language_code=uz`, `pcm_16000` both ways, `is_final_audio_for_turn`.
- **Routing:** unchanged from slice 1: Uzbek locales only ElevenLabs; ru/en ElevenLabs first with Deepgram/Cartesia as configured fallbacks. Deepgram and Cartesia adapters are **not written** (no keys); the registry still refuses them for Uzbek.
- **Metering (REV-03)** (`metering.ts`): `VoiceCallMeter` wraps STT and TTS. STT: the first 60 s block is reserved before the session opens (a refusal = the call is not answered); later blocks are reserved before more audio is sent, frames are held meanwhile, a refusal stops forwarding and calls `onExhausted`; unused blocks are released. TTS: each sentence is reserved by characters before it is sent; a refused sentence is never sent; an error keeps the worst case (`unknown`). Purposes `transcribe` and new `speak` (VarChar(20), no migration), basis `estimated`. Pricing `elevenlabs-2026-11-09` from https://elevenlabs.io/pricing/api read 2026-11-09: Scribe v2 Realtime $0.39/hour, v4 Turbo $0.04 per 1K characters.
- **LiveKit** (`livekit.ts`, `@livekit/rtc-node` 1.2.1, `livekit-server-sdk` 2.19.2): a call is a room. `LiveKitTelephonyGateway`: signed webhook (`WebhookReceiver`) `participant_joined` of a SIP participant = incoming call (`sip.phoneNumber`, `sip.trunkPhoneNumber`, per https://docs.livekit.io/reference/telephony/sip-participant/), accept = join the room; outbound = join, then `createSipParticipant` (`waitUntilAnswered`); transfer = `transferSipParticipant`; hang-up = `deleteRoom`. `LiveKitCallLeg`: caller audio at 16 kHz mono in 20 ms frames through an adaptive energy VAD (`energy-vad.ts`: speech after 120 ms, end of utterance after 600 ms of silence, 450 ms after utterances over 3 s); agent audio queued in order on an `AudioSource` (10 s queue); `isPlayingOut()` + `clearPlayback()` (clears the LiveKit queue) give barge-in during playout. The orchestrator now also barges in while queued audio still plays after generation ended (new optional `CallLeg.isPlayingOut`).
- **Latency, live (2026-11-09, `scripts/voice-latency-live.ts`, 10 turns, from the developer machine in Tashkent):** STT end-of-speech to committed transcript p50 292 / p95 389 ms; TTS sentence to first audio (warm socket) p50 187 / p95 201 ms; end-to-end p50 940 / p95 1041 / max 1041 ms with the LLM first token **simulated at 400 ms** and playout **simulated at 60 ms**: under 1.5 s. The real streaming turn engine is not built, so this is not yet an end-to-end measurement. LiveKit Cloud: join, publish and leave worked; the first connect took about 6.1 s (includes FFI start-up), so an inbound call should be joined as soon as the webhook arrives.
- **Quality seen in the live run (not a WER test):** on synthetic TTS audio Scribe returned e.g. "Ertaqiy saat" for "Ertaga soat" and "Sanbakhuni" for "Shanba kuni". A WER check on real recorded Uzbek speech is still required before any tenant goes live (ADR order above).

Still open: Nest wiring (config validation, webhook route, call record persistence), the streaming LLM turn engine and its real latency, Deepgram/Cartesia adapters, recording egress to S3, a real SIP trunk test, the output script of STT for `uz-Cyrl` callers (not checked; D17).
