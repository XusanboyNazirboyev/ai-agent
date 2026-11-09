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
