# ADR 033: Knowledge from company videos

- **Status:** Proposed, 2026-11-02. Not accepted: the provider and the open questions below are the owner's to decide.
- **Date:** 2026-11-02
- **Inputs:**
  - ADR 019 (knowledge is text only; passages are rendered verbatim as facts with provenance);
  - D1, D2, D5, D10, D15, D16, D17, D18;
  - Open Questions 8 (speech-to-text) and 9 (retention, residency);
  - the plan [`docs/design/video-knowledge-plan.md`](../design/video-knowledge-plan.md).

## Owner decisions (2026-11-02)
1. **Order:** video knowledge comes before learning from customer questions.
2. **Approval:** anything learned (from a video or, later, from customer questions) reaches customers only after an admin approves it.
3. **Timing:** this ADR and the plan come first; code waits until the current phase (7.3) is closed.

## Context
- **The need:** companies explain their products in videos (demos, reviews, reels), and customers ask about what a video shows.
- **Today's limit:** the knowledge base takes text only. A document holds at most 40 000 characters and a tenant at most 200 documents (`knowledge-documents.controller.ts`), so what a video says cannot be searched.
- **The fact problem:** ADR 019 renders a knowledge passage verbatim as a fact with provenance.
  - A price, discount, stock level or date spoken in a video would therefore be quoted to customers.
  - D1 says such facts come only from the tenant's CRM or DB, and a video is out of date as soon as a price changes.
- **No provider yet:** no speech-to-text provider is chosen (Open Question 8), and Uzbek speech quality has never been measured. Voice messages stay deferred (owner decision 2026-10-24).

## Decision (proposed)
**1. A video becomes reviewed text, never a new kind of fact.**
1. An admin uploads a video on the Knowledge page.
2. A background job (BullMQ) sends it to a `MediaUnderstandingProvider`.
3. The job stores a **draft**:
   - transcript segments with `MM:SS` times, spoken language and script (D17);
   - visual notes: which product is shown, its parts and features, how it is used.
4. The admin reads and edits the draft, then approves or rejects it.
5. Approval saves an ordinary knowledge document: source kind `video`, the video's title, segment times kept as passage metadata.

- **How the agent answers:** the document is chunked and embedded like any other. The agent answers through the existing `knowledge_search`, so the turn logic in `core/**` does not change.
- **Before approval:** a draft is never retrievable by the agent.

**2. Hard facts stay out of video knowledge (D1, D5, D10).**
- **Extraction:** the instructions to the provider exclude prices, discounts, stock, dates and schedules.
- **Code check:** code scans the draft with the guardrail's money, percentage and date detectors and marks every match.
- **Approval rule:** approval is refused while a money or percentage span remains. A date span shows a warning.
- **Catalog link:** the admin can link the video to catalog items. When a customer asks the price of something seen in the video, the agent fetches the live price through the connector tools (D10), not from the video.

**3. Provider behind an interface (D15).**
- **Where:** the interface lives in core and holds nothing vertical- or vendor-specific. Implementations live outside core, next to the LLM providers.
- **Metering:** calls are metered through the existing ledger with purpose `media`. A model without a price is refused, as for embeddings.
- **Candidates:** facts are from the official docs, read 2026-11-02 (the docs show no last-updated dates).

| Candidate | What the official docs state | Gaps |
|---|---|---|
| **Gemini API, video understanding** (preset `gemini` already in the repo) | Audio and frames in one call. Formats include mp4, mov, mpeg, webm, 3gpp. Static mode samples 1 frame/s, about 100 tokens/s at low and about 300 tokens/s at default media resolution; up to 3 h at low resolution with a 1M-token context. Files API: 2 GB per file, 20 GB per project, files kept 48 h. Paid tier: prompts and responses are not used to improve products; unpaid tier: they are, and humans may review them (terms effective 2026-03-23). Gemini 3.8 Flash input $0.75 per 1M tokens through 2026-12-31, $1.50 from 2027-01-01. | Uzbek audio quality unmeasured. The page also gives 20 GB (paid) for the Files API and both 20 MB and 100 MB for inline requests: conflicting, use the Files API. Whether files can be deleted before 48 h: not checked. |
| **Google Cloud Speech-to-Text v2** | `uz-UZ` with `chirp` and `chirp_2` (asia-southeast1, europe-west4) and `chirp_3` (eu). | Audio only: the visual part needs a second call. Needs its own Google Cloud project and credentials. Quality unmeasured. |
| **OpenAI transcription** | Recommended model `gpt-transcribe`; files up to 25 MB; mp3, mp4, mpeg, mpga, m4a, wav, webm. `whisper-1` and the `gpt-4o-*-transcribe` models shut down 2027-02-26. | Uzbek not listed on the page: **unverified**. Audio only. |

- **Proposal:** Gemini on the **paid tier only**, because tenant videos can show people and unpaid-tier content is used for training. It is the first implementation if slice 0 of the plan meets the quality threshold. Google `chirp_3` is the fallback for the audio if Uzbek transcripts fail.
- **Rough cost (estimate, not metered):** a 10-minute video at low resolution is about 60 000 input tokens, about $0.05 on Gemini 3.8 Flash at the 2026 price.

**4. The video file is not kept.**
- After the job, the upload is deleted on our side, and on the provider's side where the API allows it.
- Keeping originals waits for Open Question 9.

**5. Limits and quality.**
- **Per tenant:** maximum file size, maximum duration and a monthly media budget (values: open question).
- **Quality gate (D18):** video knowledge is `beta` per language until its eval passes and a native speaker has reviewed it.

## Open questions (none assumed)
| # | Question | Blocks |
|---|---|---|
| V1 | Which provider: Gemini paid, or Google STT plus a vision call? Decided on the slice 0 results. | Slice 1 |
| V2 | The quality threshold for Uzbek (and Russian): key-fact recall, invented facts allowed (proposed 0), and who the native reviewer is. | Slice 0 acceptance |
| V3 | 10–20 sample videos from a real tenant, used with the tenant's consent. | Slice 0 |
| V4 | A paid Gemini key and budget for the measurement. | Slice 0 |
| V5 | Maximum video size and duration, and the monthly media budget per tenant. | Slice 1 |
| V6 | May the original video be kept, and where (Open Question 9)? Default: no. | Slice 1 |
| V7 | Video sources beyond uploads (Instagram posts, YouTube links). | Later slice |
| OQ8 | If this ADR is accepted, it settles speech-to-text **for videos only**. Voice messages stay deferred. | — |

## Consequences
- **Gain:** customers get answers about what company videos show, with the same provenance and review as text documents.
- **Unchanged:** prices and availability still come only from the CRM. A video linked to catalog items makes the agent fetch them live.
- **Cost:** admins review every video before it counts. This is the price of decision 2.
- **Reuse:** the draft and review queue can later serve the second feature, knowledge suggested from frequent customer questions (source kind `conversation`), under its own ADR.

## Alternatives considered
- **Multimodal embeddings of the video:** rejected. Vector similarity is not a fact (D1), and there is no passage text to cite.
- **Sending the video to the model on each customer turn:** rejected. It costs money and latency on every turn, and unreviewed output would reach customers.
- **Publishing drafts without review:** rejected by the owner (decision 2).
