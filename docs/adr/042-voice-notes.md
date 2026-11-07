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
