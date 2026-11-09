# ADR 042: Customer voice notes (speech-to-text)

- **Status:** Accepted, 2026-11-07 (owner chose Gemini; provider stays off until Uzbek quality is measured).
- **Context:** Telegram voice notes were ignored (`unsupported`), so a customer who spoke got no answer. `docs/VOICE_READINESS.md` defined the port and policy and left the provider to the owner.

## Decision

- **Provider:** `gemini-3.5-transcribe` through the official SDK `@google/genai` 2.32.0 (`interactions.create`, inline audio, `transcription_config.language_codes` + `custom_vocabulary`, transcript in `output_text`). Docs read 2026-11-07: https://aistudio.google.com/docs/transcribe.md (Uzbek `uz-UZ` listed; OGG and Opus accepted), https://aistudio.google.com/docs/audio.md, https://aistudio.google.com/docs/pricing.md (about $0.005 per minute; paid tier content is not used to improve products). `STT_PROVIDER=none` (default) or `gemini` with `STT_API_KEY` (a paid-tier key).
- **Intake:** a Telegram voice note (Bot API `Voice`, read 2026-11-07) is stored as a `VOICE` message with empty text, `voice_status=PENDING`, `media_ref` = file_id, mime type and duration (additive migration `20261111090000_voice_messages`). A malformed voice object is ignored, never fatal to the update.
- **Worker:** before the agent runs, `VoiceTranscriptionService` checks the voice policy (type, length) before downloading, downloads with `getFile` (link holds the bot token: never logged; at most 5 MB by policy, 20 MB by Telegram), checks the size, transcribes, and stores `TRANSCRIBED` with the transcript as the message text or `FAILED` with an empty text.
- **Agent:** a transcript is ordinary untrusted customer text. A batch whose only content is a failed note is answered by code without a model call: "please type" (`voiceNotUnderstood`), and after a second failed note in a row a handover (`VOICE_UNREADABLE`). The echo (agent OFF) sends nothing for an empty batch.
- **Inbox:** a voice note shows "🎤 Voice message (transcript)", "transcribing…" or "could not be understood".
- **Not done:** echoing the transcript back to the customer ("I heard: …") — digits in a transcript would trip the fact guardrail (D5); Instagram and Messenger audio attachments (their payload shape is not verified yet).

## Before enabling `gemini`

Measure word error rate on the owner's recordings (10 scripted Uzbek/Russian phrases); record the result here; then decide with the owner whether transcripts without a confidence need confirmation (`decideVoice` treats unknown confidence as unconfirmed; today it is only logged).

## Amendment 2026-11-09: metering (audit REV-03)

- Before audio leaves the server, the worst case (`STT_WORST_CASE_USD_PER_MINUTE`, default $0.02/min, 4x the pricing page's own ~$0.005/min estimate) is reserved on the same ledger as model calls (tenant monthly cap `LLM_TENANT_MONTHLY_BUDGET_USD`, conversation cap `LLM_CONVERSATION_BUDGET_USD`). A refused reservation means no provider call: the note is FAILED (`BUDGET_EXHAUSTED`) and the customer is asked to type.
- Spend is the provider-reported tokens at the paid-tier prices of https://aistudio.google.com/docs/pricing.md read 2026-11-09: input (audio) $2.00, output (text, including thinking) $12.00 per 1M tokens; thought tokens are billed as output. The record is an `llm_usage_records` row with purpose `transcribe` and turn key `voice:<messageId>`. Without reported usage, or on a timeout or error, the worst case stays counted (reservation UNKNOWN).
- REV-01, owner decision 2026-11-09: voice notes are transcribed also when the account's agent mode is OFF, so operators can read them without listening; this is the current behaviour, and the budget metering above still applies.

## Amendment 2026-11-09: first measurement on the owner's recordings (the "before enabling `gemini`" step)

Owner priority (fifth decision, 2026-11-09): speech to text of voice notes comes first; replies stay text (voice replies and calls are paused, ADR 045). Measured with `scripts/stt-compare.ts` through the production `SpeechToText` adapters on the owner's 9 Telegram voice notes (OGG, 32 s of audio, one speaker, quiet room; exact words written by the owner; 54 reference words: 38 uz-Latn, 5 uz-Cyrl, 11 ru). One run per mode unless stated; the corpus WER counts words after folding apostrophes and, for Uzbek, after transliterating both sides to Latin.

| Mode (adapter configuration)                                  | All lines | uz-Latn | ru           | Median per clip | Notes                                                                 |
| ------------------------------------------------------------- | --------- | ------- | ------------ | --------------- | --------------------------------------------------------------------- |
| `gemini-3.5-transcribe`, languages uz/ru/en offered (default) | 35-37%    | 47%     | 9-18%        | 2.7-2.9 s       | two runs: 19/54 and 20/54 errors; always Latin for Uzbek; no failures |
| the same, languages narrowed to uz/ru                         | 43%       | 55%     | 18%          | 2.8 s           | no gain                                                               |
| the same, tenant words as `custom_vocabulary`                 | 41%       | 53%     | 18%          | 2.7 s           | no gain (10 words, within noise)                                      |
| ElevenLabs Scribe v2 file endpoint, language detected         | 57%       | 61%     | 36%          | 1.0 s           | **detected Uzbek as Turkish and Russian as Polish**                   |
| ElevenLabs, `language_code=uz` forced                         | 50-54%    | 63-66%  | 0% (!)       | 1.1-1.3 s       | forcing Uzbek still recognised the Russian clips                      |
| ElevenLabs, auto language + keyterms                          | 44-46%    | 47-50%  | 55% (Polish) | 1.0 s           | keyterms helped Uzbek, language detection still misfires              |

- **Decision:** keep Gemini (ADR 042's choice) with the default configuration as the voice-note provider; no vocabulary or language narrowing for now. The ElevenLabs file adapter (`src/speech/elevenlabs-speech-to-text.ts`, tested with a fake transport) stays in the code, **not wired**: automatic language detection is not safe for Uzbek, and it has no token pricing (billed by audio time), so metering would keep the worst case counted.
- **Caveats (do not read these as a production WER):** one speaker, 9 short clips, 54 words; run-to-run variation exists (±1 word). On lines 3, 4 and 8 all providers agree with each other and not with the written words (e.g. all say "…keyin ham dars bo'ladimi?" for the written "…dars bormi?"), and the owner confirmed (2026-11-09) that the written words are exactly what was said: this is a recognition error all models share (they replace the spoken words with a more common phrasing), so the figures above stand as measured. On line 5 (a spoken phone number) the providers disagree with each other and with the written digits: digits from speech are the least reliable part. Noise, accents, longer clips and mixed Uzbek/Russian sentences were not tested. A native-speaker review is still required for the "stable" label (D18).
- **Seen:** every Uzbek transcript came back in Latin script, also for the line written in Cyrillic (the speech has no script). Whether a Cyrillic-writing customer who sends a voice note should get a Cyrillic reply is a policy question (D17), open.
- **Cost of the measurement** (estimates from the pricing pages, not from billing): about 3 minutes of Gemini audio (about $0.02) and about 4 minutes of ElevenLabs audio.
- **Open and blocking enabling for a tenant:** (1) a transcript is used as ordinary customer text; `decideVoice` computes `needsConfirmation` (always true: Gemini reports no confidence) but nothing uses it, so a misheard phone number or date goes straight to the agent. Owner decision needed: confirm what was understood (echo the transcript, which D5 allows only if digits are handled), or never take phone numbers and dates from speech without a typed confirmation, or accept the risk. (2) Staging needs `STT_PROVIDER=gemini` and `STT_API_KEY` (a paid-tier key) in its environment; the local `.env` has neither. (3) Instagram and Messenger audio are still not handled.

## Amendment 2026-11-09: digits heard by a machine are not a phone number (owner chose this work)

Owner, the same day: no calls; only voice notes are answered, in text. Of the open item "(1) misheard digits", the owner picked the safe direction; the exact variant stays configurable:

- `VOICE_DIGITS_POLICY` = `typed` (default) | `accept`. With `typed`, a phone number is taken only from text the customer typed: when the answered batch contains a voice-note transcript (`voice_status = TRANSCRIBED`), neither the contact phone capture (Telegram pipeline) nor the booking flow (`ActionService.turnContext`) reads a number from it; the booking flow then asks for the phone again (`phoneRequest`), and the typed number is used. This matters because a stored phone is never replaced (`capturePhone` writes only when the contact has none), so a misheard first number would have stayed. Any value other than an explicit `accept` behaves as `typed` (fail safe). `accept` restores the earlier behaviour.
- Not changed: dates, times and bookings already go through a proposal the customer must confirm exactly (ADR 024/046), so a misheard date is shown back before anything is booked. The agent may still repeat a number from a transcript in its own reply only through the normal guardrail (a number the customer "said" counts as customer text).
- Not built: echoing the transcript ("I heard: …") to the customer; a dedicated "please type the number" message on the voice turn itself (the booking flow re-asks; a lead without an action just has no phone yet). Instagram/Messenger voice notes are not handled at all yet.
- Tests: unit (`leads/phone.spec.ts`, including the fail-safe), integration (`telegram-agent.integration.spec.ts`: a heard number is not stored, the typed one is, `accept` stores it; `action-pipeline.integration.spec.ts`: no proposal from a heard number, the phone is asked again, the typed number makes the proposal; checked by disabling the guard, which makes it fail).

## Amendment 2026-11-09: the project's Gemini key serves voice notes

Owner: the paid `GEMINI_API_KEY` already in the environment is to be used. Voice-note STT now takes `STT_API_KEY` if set, else `GEMINI_API_KEY` (`sttApiKey`); `STT_PROVIDER=gemini` validates with either. The key must be a paid-tier key (the owner states it is; not verified here). To enable on staging: deploy a build that contains this change and add `STT_PROVIDER=gemini` (and `GEMINI_API_KEY` if missing) to the host's `deploy/.env.production`, then restart `api`; this needs AWS access, which this session did not have. Until then the bot answers a voice note with "please type".
