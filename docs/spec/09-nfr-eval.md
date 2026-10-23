## 11. NON-FUNCTIONAL REQUIREMENTS

- **Reliability**: at-least-once processing + idempotent handlers; dead-letter queue; graceful degradation when LLM/connector down.
- **Latency**: model tiering (fast for extraction/classification/language detection, strong for hard turns); parallelize independent tool calls; never cache price/availability for display.
- **Cost**: token budgets per conversation, prompt size limits, cost metrics per tenant/conversation.
- **Security**: secrets in env/secret manager; webhook signature verification; strict tenant isolation in every query; rate limiting; PII redaction; encryption at rest; least-privilege connector credentials (read-only where possible); dependency audit in CI.
- **Privacy**: purpose-limited phone collection; data deletion support; retention policy **[OPEN]**.
- **Observability**: structured logs (traceId, conversationId, tenantId, language), metrics (first-response time, auto-resolved rate, handover rate by reason, lead capture rate, guardrail block rate, tool/connector error rate, language-detection confidence, cost per conversation); alerts on error spikes and queue backlog.
- **Testing**: unit (slots, guardrails, scoring, transliteration), integration (webhook → queue → reply with mocked LLM/connector), connector conformance suite, eval suite, load test before launch.

---

## 12. EVALUATION (QUALITY GATE)

- `eval/cases/<pack>/<locale>/*.json`. Example:
```json
{ "id": "edu-uz-latn-001", "pack": "education", "locale": "uz-Latn",
  "turns": [{"from":"customer","text":"IELTS kursi kerak edi"}],
  "expect": { "mustCallTools": ["search_catalog"], "slotsExtracted": {"subject":"IELTS"},
              "mustHandover": false, "forbidden": ["invented_price"], "replyLanguage": "uz", "replyScript": "Latn" } }
```
- Initial target: 100+ cases per launch pack covering normal flows, ambiguity, typos, mixed languages/scripts, apostrophe variants, trick questions (nonexistent item, price not in catalog), complaints, injection attempts, regulated info, voice transcripts.
- Metrics: hard-fact accuracy (**must be 100% on "no invented facts"**), slot extraction accuracy, handover correctness, language/script match, turns-to-quote.
- CI runs the suite on changes to prompts, packs, locale packs, tools, models, guardrails; regressions block merge.
- Per-locale pass thresholds drive the `stable`/`beta` status (D18).
- Production loop: operator corrections and handovers export as new eval cases.

---
