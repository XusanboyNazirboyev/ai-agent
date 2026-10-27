# ADR 027: Web AI bot switch and FAQ knowledge page

- **Status:** Proposed; accepting it is an owner decision. The decisions below are **implemented on `main`**: the API (`PUT /api/v1/channels/:id/agent-mode`, `GET /api/v1/channels`, the FAQ endpoints under `/api/v1/knowledge/faq`) through `feat/web-api` (`6db8ac7`), and the AI bot and Knowledge pages through `feat/web-design-pages` (`b5f68a2`). FAQ file import and the Knowledge documents tab are not on `main` (branch `feat/knowledge-faq-import`, not merged).
- **Date:** 2026-10-25 (status corrected 2026-10-26; implementation status updated 2026-10-27)

## Decisions
- **Assistant mode from the web.** `PUT /api/v1/channels/:id/agent-mode` sets OFF / SHADOW / LIVE for one channel account of the session's tenant. OWNER and ADMIN only; the same policy as the `agent:mode` command (`modeRefusalCode` mirrors `liveModeRefusal` / `shadowModeRefusal`), so the web cannot enable anything the command refuses (LIVE outside development without the operator notifier, untrusted provider). `GET /api/v1/channels` returns, per mode, a machine-readable refusal code that the UI translates and uses to disable the choice. Turning "On" (LIVE) needs a confirmation dialog. Every change writes an `AuditEvent` (`channel.agent_mode_changed`, from/to).
- **FAQ as knowledge documents.** One question/answer = one `KnowledgeDocument` (`source = faq:<uuid>`, topic `faq`), one chunk whose text is the answer (what is rendered to the customer, ADR 019) and whose vector embeds question + answer. Limits (question 200, answer 600 chars, 500 entries) keep an entry to a single chunk so it is read back exactly; whitespace is normalised on input. Create/update/delete are OWNER/ADMIN only and audited; delete archives (withdraws from retrieval). Read is open to every signed-in role.
- **Data protection.** The text goes to the embedding provider (as with the ingest script). The API requires `confirmProviderMayReadText: true` and the form requires an explicit acknowledgement that the text is not confidential. With `KNOWLEDGE_EMBEDDINGS=off` writes answer 503 `KNOWLEDGE_DISABLED` and the page says so; nothing is stored half-way (embedding happens before the transaction).
- No new fact path: the assistant still quotes passages verbatim with provenance; regulated entries keep the LEGAL_UNVERIFIED recency rule.

## Not done
- No UI to connect a channel, set tokens or choose the model/embedding provider (needs a secrets design). Retrieval at answer time still depends on pack configuration and a trusted embedder (ADR 019); the page does not change that and does not test retrieval quality.
- Bulk import / file upload of knowledge, and per-conversation assistant switch, are not built.
