# Voice readiness (Open Question 8)

Status: **port and policy only. No provider is chosen or integrated.** Voice messages are currently not processed by the Telegram intake. No Uzbek (or any) speech-to-text quality has been measured, so no language support is claimed.

## What exists
- `core/speech/speech-to-text.ts`: provider-neutral `SpeechToText` port, `NotConfiguredSpeechToText` default (always `NOT_CONFIGURED`), clip limits (`checkClip`, checked before any audio leaves the server), outcome policy (`decideVoice`), cost bound (`worstCaseTranscriptionNano`).
- Defaults (changeable): 5 MiB, 60 s, `audio/ogg|mpeg|mp4|wav`, 20 s timeout, transcript of at least 2 characters, confirm when confidence is unknown or below 0.6, handover after 2 consecutive failures.
- Rule enforced by tests: a failed, timed-out, unsupported or empty transcription is never a customer message. It becomes "ask to type", then a handover recommendation. A transcript is untrusted customer text.

## Decision required from the owner
| Decision | Options | Needed before |
|---|---|---|
| Provider | A hosted STT API, a hosted multimodal LLM, or a self-hosted open model | any integration |
| Uzbek evidence | Measured word error rate on our own recordings per language and script | claiming support |
| Data protection | Is customer audio allowed to leave the country/provider region; retention; whether the provider trains on it | sending any real audio |
| Budget | Per-minute price; monthly tenant cap for voice | enabling for a tenant |
| Behaviour | Confirm low-confidence transcripts ("did you mean ...?"), or always | design freeze |

Trade-offs (no vendor claims are made here; every price, language list and limit must be taken from the provider's official documentation, with URL and date, before use):
- Hosted STT API: least work; cost per minute; audio leaves our infrastructure; Uzbek quality unknown until measured.
- Hosted multimodal LLM: one vendor for text and audio; per-token audio cost; same data-leaving issue; quality unknown until measured.
- Self-hosted open model: audio stays with us; needs GPU/CPU capacity and operations; Uzbek quality unknown until measured.

## Test plan (run once a provider is approved)
Own recordings, consented or synthetic, no production customer audio. For each: expected transcript, expected slots.
1. Uzbek Latin; 2. Uzbek Cyrillic (where used); 3. Russian; 4. mixed Uzbek/Russian in one sentence; 5. noisy audio (street, car); 6. short and long clips at the limits; 7. silence; 8. slot cases: missing slot (agent must ask), wrong slot (agent must not act on a low-confidence number or date without confirmation).
Acceptance: per-language error rate and slot accuracy recorded in `docs/` with date; a language is marked supported only after the same stable/beta rule as text (D18).

## Required behaviour when integrating
- Tenant budget: reserve worst case before the call, settle after; unknown billing counts as unknown-usage exposure (as for LLM and embeddings); add a `transcribe` purpose.
- Privacy: audio is not stored after transcription unless a retention rule is approved; no audio or transcript text in logs (only ids, durations, codes).
- Limits: `checkClip` before download/upload; Telegram file download with size cap; abort on `timeoutMs`.
- Idempotency: one transcription per inbound channel message id.
