## 9. DOMAIN MODEL (Prisma sketch; refine in Phase 1; all tables include `tenantId`, timestamps)

`Tenant` (config JSON: packId, connectorConfig ref, locales, tone, thresholds), `Channel`, `Contact` (external IDs, phone, language, script, consent), `Conversation` (state, assignedOperator, lastCustomerMessageAt, language, script), `Message` (direction, channelMessageId UNIQUE per channel, type, text, transcript, detectedLang), `ConversationSlots` (JSON, version), `Lead`, `Handover`, `ToolCallLog`, `CatalogItem` + `Offer` (canonical synced copy, with normalized-search columns and aliases), `Alias`/`Synonym`, `KnowledgeDoc` + `KnowledgeChunk` (pgvector), `DomainPackVersion`, `LocalePackVersion`, `EvalCase`/`EvalRun`/`EvalResult`.
Never store card numbers or government ID numbers in logs; redact on ingestion.

---

## 10. CHANNELS

- **Telegram (Phase 2)**: webhook with `secret_token` verification; text, voice, photo; inline keyboards for quick choices; dedupe by `update_id`.
- **Instagram/WhatsApp (Phase 8)**: Meta official APIs only. Verify `X-Hub-Signature-256`; token refresh; messaging-window/template rules. Start business verification early.
- All channels: idempotent processing, per-conversation ordering, retry with backoff on send failure, raw payloads stored redacted.

---
