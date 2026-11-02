# ADR 033: Knowledge from the videos on the connected Instagram account

- **Status:** Proposed, 2026-11-02. Not accepted: the provider and the open questions below are the owner's to decide.
- **Date:** 2026-11-02
- **Inputs:**
  - ADR 031 (Instagram DM channel, Instagram API with Instagram Login on `graph.instagram.com`);
  - ADR 019 (knowledge is text only; passages are rendered verbatim as facts with provenance);
  - D1, D2, D5, D6, D10, D15, D16, D17, D18;
  - Open Questions 8 (speech-to-text) and 9 (retention, residency);
  - the plan [`docs/design/video-knowledge-plan.md`](../design/video-knowledge-plan.md).

## Owner decisions (2026-11-02)
1. **Source:** the videos the company posts on its **connected Instagram account**. The agent analyses them and answers customers' DM questions about the products they show. There is no video upload in tezda (an earlier upload draft of this ADR was dropped by the owner).
2. **Order:** video knowledge comes before learning from customer questions.
3. **Approval:** anything learned reaches customers only after an admin approves it. Whether this also holds for Instagram videos is asked again in V7, not assumed.
4. **Timing:** this ADR and the plan come first; code waits until the current phase (7.3) is closed.

## Context
- **The need:** companies show products in posts and reels. Customers write in DM "how does this work?" or "what is the price?", often after sharing the post itself.
- **Today:** the agent knows nothing about the account's posts. ADR 031 reads only text DMs: messages without text, including shared posts, are acknowledged as ignored.
- **The fact problem:** ADR 019 renders a knowledge passage verbatim as a fact. A price spoken in a reel or written in its caption would therefore be quoted to customers. D1 says such facts come only from the CRM or DB, and a post is out of date as soon as a price changes.
- **No provider yet:** no speech-to-text provider is chosen (Open Question 8), and Uzbek speech quality has never been measured.

## What the official Meta docs say (read 2026-11-02; the pages show no last-updated dates)
- **IG Media** ([reference](https://developers.facebook.com/docs/instagram-platform/reference/instagram-media)):
  - **Fields:** `media_type` is `CAROUSEL_ALBUM`, `IMAGE` or `VIDEO`. `permalink`, `thumbnail_url` (video only) and `timestamp` (ISO 8601, UTC) are also available.
  - **Permission:** with Instagram Login the required permission is `instagram_business_basic`.
  - **`media_url` can be missing:** it is omitted when a video contains copyrighted or licensed audio (including the Instagram audio library) or is flagged for copyright, even for the owner's own media. The docs say to treat it as optional and fall back to `permalink` or `thumbnail_url`.
- **Facebook-Login-only fields:** the same page marks `caption` and `media_product_type` (`FEED`, `REELS`, `STORY`, `AD`) as "Facebook Login only". **Unverified for our Instagram Login token.**
- **IG User media edge** ([reference](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media.md)):
  - returns at most the 10 000 most recent media, with time-based pagination (`since`, `until`);
  - stories are not included (they have their own endpoint).
  - **Unverified:** the page documents only Facebook Login permissions. The exact path and behaviour under Instagram Login are unconfirmed.
- **Webhooks** ([fields](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields)): no field announces newly published media. New posts must therefore be found by polling.
- **Shared posts in DM** ([ig_post](https://developers.facebook.com/documentation/instagram-platform/webhooks/new.md)):
  - an `ig_post` attachment carries `ig_post_media_id`, `title` (caption) and `url`; the old `share` type ended on 2026-02-01.
  - The examples page also lists `ig_reel` and `reel` attachment types, but documents no fields for them.
  - **Unverified:** whether `ig_post_media_id` equals the media id returned by the media edge.

## Decision (proposed)
**1. Sync the account's videos.**
- **Polling:** for every active Instagram channel, a scheduled job lists the account's media since the last sync, and admins have a "sync now" button.
- **What is processed:** only `VIDEO` items in the first slice (V8).
- **New or changed video:** the video goes to a `MediaUnderstandingProvider`. If `media_url` is absent, only the caption and the thumbnail are used, and the draft says so.
- **Removed post:** the knowledge built from a post that is no longer on the account is switched off at the next sync.

**2. A video becomes reviewed text, never a new kind of fact.**
- **The draft holds:**
  - transcript segments with `MM:SS` times, spoken language and script (D17);
  - visual notes: which product is shown, its parts and features, how it is used;
  - the caption, where readable.
- **Approval** (V7) turns the draft into an ordinary knowledge document: source kind `instagram_video`, with the media id and permalink.
- **How the agent answers:** the document is chunked and embedded like any other, and the agent answers through `knowledge_search`, so the turn logic in `core/**` does not change.
- **Before approval:** a draft is never retrievable.

**3. Hard facts stay out (D1, D5, D10).**
- **Extraction:** the provider instructions exclude prices, discounts, stock, dates and schedules.
- **Code check:** code scans the draft and the caption with the guardrail's money, percentage and date detectors. Money and percentage spans are removed from the published text; a date span is marked for the admin.
- **Catalog link:** each video can be linked to catalog items. Code suggests matches by name and the admin confirms them. A price question about a linked product is answered from the connector tools (D10), never from the post.

**4. The question is linked to the post it is about (D6).**
- **Adapter change (ADR 031):** a DM with an `ig_post` attachment, or a reel attachment once its fields are verified, becomes a message with a **referenced media id** instead of being ignored.
- **Retrieval:** passages from that video's document rank first, and its linked catalog items are the first candidates for tool lookups.
- **A share with no text:** the bot behaviour is open (V10).

**5. Provider behind an interface (D15).**
- **Where:** the interface lives in core and holds nothing vertical- or vendor-specific. Implementations live outside core, next to the LLM providers.
- **Metering:** calls are metered through the existing ledger with purpose `media`. A model without a price is refused.
- **Candidates:** facts are from the official docs, read 2026-11-02.

| Candidate | What the official docs state | Gaps |
|---|---|---|
| **Gemini API, video understanding** (preset `gemini` already in the repo) | Audio and frames in one call. Formats include mp4, mov, mpeg, webm, 3gpp. Static mode samples 1 frame/s, about 100 tokens/s at low and about 300 tokens/s at default media resolution. Files API: 2 GB per file, 20 GB per project, files kept 48 h. Paid tier: prompts and responses are not used to improve products; unpaid tier: they are, and humans may review them (terms effective 2026-03-23). Gemini 3.8 Flash input $0.75 per 1M tokens through 2026-12-31, $1.50 from 2027-01-01. | Uzbek audio quality unmeasured. Inline request limit stated as both 20 MB and 100 MB: use the Files API. Early deletion of uploaded files: not checked. |
| **Google Cloud Speech-to-Text v2** | `uz-UZ` with `chirp` and `chirp_2` (asia-southeast1, europe-west4) and `chirp_3` (eu). | Audio only: the visual part needs a second call. Separate Google Cloud project and credentials. Quality unmeasured. |
| **OpenAI transcription** | `gpt-transcribe`; files up to 25 MB; mp3, mp4, mpeg, mpga, m4a, wav, webm. `whisper-1` and the `gpt-4o-*-transcribe` models shut down 2027-02-26. | Uzbek not listed on the page: **unverified**. Audio only. |

- **Proposal:** Gemini on the **paid tier only**, because posts can show people and unpaid-tier content is used for training. It is the first implementation if slice 0 meets the quality threshold, with Google `chirp_3` as the fallback for the audio.
- **Rough cost (estimate, not metered):** a 1-minute reel at low resolution is about 6 000 input tokens, well under one cent.

**6. Video files are not kept.**
- A downloaded video is deleted after the job.
- Keeping originals waits for Open Question 9.

**7. Limits and quality.**
- **Per tenant:** maximum duration and a monthly media budget (values: V5).
- **Quality gate (D18):** video knowledge is `beta` per language until its eval passes and a native speaker has reviewed it.

## Open questions (none assumed)
| # | Question | Blocks |
|---|---|---|
| V1 | Which provider: Gemini paid, or Google STT plus a vision call? Decided on the slice 0 results. | Slice 1 |
| V2 | The quality threshold for Uzbek (and Russian): key-fact recall, invented facts allowed (proposed 0), and who the native reviewer is. | Slice 0 acceptance |
| V3 | A real Instagram business account with product videos, used with the owner's consent, for measurement. | Slice 0 |
| V4 | A paid Gemini key and budget for the measurement. | Slice 0 |
| V5 | Maximum video duration and monthly media budget per tenant. | Slice 1 |
| V6 | May the original video be kept, and where (Open Question 9)? Default: no. | Slice 1 |
| V7 | Does admin approval (owner decision 3) hold for Instagram videos, or may an analysed post answer customers at once? | Slice 1 |
| V8 | Which media: only videos and reels, or also photos, carousels and stories (stories expire after 24 h)? | Slice 1 |
| V9 | Polling interval, and how far back the first sync reaches (all past posts, or the last N months). | Slice 1 |
| V10 | When a customer shares a post with no text, does the bot answer first ("this is X, what would you like to know?") or wait? | Slice 3 |
| V11 | Live read-only calls to verify the unverified points above (media path and `caption` under Instagram Login, reel attachment fields, media id match) on a test account. Live Instagram calls need explicit approval. | Slices 0 and 3 |
| OQ8 | If this ADR is accepted, it settles speech-to-text **for videos only**. Voice messages stay deferred. | — |

## Consequences
- **Gain:**
  - the company keeps posting on Instagram as before, and the agent learns what each video shows;
  - a customer who shares a post gets answers about that product;
  - prices and availability still come only from the CRM.
- **ADR 031 changes:** shared-post DMs are no longer ignored (slice 3).
- **Dependence on Meta:** if `media_url` is withheld (copyrighted audio), that video gives only caption and thumbnail knowledge.
- **Reuse:** the draft and review queue can later serve knowledge suggested from frequent customer questions (source kind `conversation`), under its own ADR.

## Alternatives considered
- **Upload in tezda:** dropped by the owner (decision 1).
- **Multimodal embeddings of the video:** rejected. Vector similarity is not a fact (D1), and there is no passage text to cite.
- **Sending the video to the model on each customer turn:** rejected. It costs money and latency on every turn, and unreviewed output would reach customers.
