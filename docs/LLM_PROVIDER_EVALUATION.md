# LLM provider evaluation (Phase 4)

**Researched:** 2026-10-23. **Decision:** Anthropic Claude API, `claude-haiku-5-5` for both tiers, with STRONG upgradeable to `claude-sonnet-5-5` by configuration. Recorded in [ADR 008](adr/008-llm-provider-and-cost-controls.md).

**What this is not:** no provider was called. No API key exists in this environment (none of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY` is set, and `.env` has no provider entry), so **no live quality, latency or Uzbek measurement exists for any provider**. Everything below is from official documentation and pricing pages, plus measurements of AgentCore's own prompts.

## 1. Sources consulted (2026-10-23)

| Provider | Pricing | Tool calling | Other |
|---|---|---|---|
| Anthropic | [platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing) | [How tool use works](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works) | [Supported countries](https://www.anthropic.com/supported-countries), [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention), SDK `@anthropic-ai/sdk` 1.1.0 type definitions |
| OpenAI | `platform.openai.com/pricing` returned HTTP 403; used [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing) | [Function calling](https://developers.openai.com/api/docs/guides/function-calling) | [Supported countries](https://developers.openai.com/api/docs/supported-countries), [Your data](https://developers.openai.com/api/docs/guides/your-data) |
| Google | [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) | [Function calling](https://ai.google.dev/gemini-api/docs/function-calling) (only the first ~100K characters of the page were read) | [Available regions](https://ai.google.dev/gemini-api/docs/available-regions) |

All three list **Uzbekistan** (and Kazakhstan, Kyrgyzstan, Tajikistan) as supported, so availability does not decide anything.

### Re-verification, 2026-10-23 (Phase 4B)

These Anthropic facts were re-read on the official pages before the prices moved into versioned config (`apps/api/src/llm/pricing-catalog.ts`).

From the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing):
- **Claude Haiku 5.5:** $0.10 input, $0.125 5-minute cache write, $0.20 1-hour cache write, $0.01 cache hits, $0.50 output, all per MTok, "for prompts up to 100,000 tokens". For prompts over 100,000 tokens: $0.50, $0.625, $1, $0.05 and $2.50. Prompt length "counts all of its input tokens, including cache reads and cache writes".
- **Claude Sonnet 5.5:** $2, $2.50, $4, $0.10 (0.05x) and $10.
- **Claude Opus 5.5:** $4, $5, $8, $0.20 (0.05x) and $20.
- **Tool-use system prompt:** 286 tokens on all three models with tool_choice auto or none. On Haiku 5.5, `any`/`tool` add 406 tokens; AgentCore uses `auto`.

From the [models overview](https://platform.claude.com/docs/en/models/overview):
- Model IDs `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`, each its own alias.
- 1M-token context window and 128K max output, with adaptive thinking.

## 2. Models and prices (USD per million tokens, standard tier)

| Model | Input | Cached input | Output | Notes |
|---|---|---|---|---|
| `claude-haiku-5-5` | 0.10 | 0.01 | 0.50 | Prompts over 100K tokens: 0.50 / 0.05 / 2.50 (prompt length includes cache reads). Cache writes 0.125 (5m) / 0.20 (1h). |
| `claude-sonnet-5-5` | 2.00 | 0.10 | 10.00 | Cache reads 0.05x input. |
| `claude-opus-5-5` | 4.00 | 0.20 | 20.00 | |
| `gpt-6-luna` (OpenAI mini) | 0.10 | 0.01 | 0.50 | The page does not say whether reasoning tokens bill as output. |
| `gpt-6.1-sol` (OpenAI) | 2.00 | 0.10 | 10.00 | Responses API required for its tool calling. |
| `gemini-3.1-flash-lite` | 0.25 | 0.025 | 1.50 | Output includes thinking. |
| `gemini-2.5-flash-lite` | 0.10 | 0.01 | 0.40 | Previous generation. |
| `gemini-3.8-flash` | 0.75 | 0.075 | 3.75 | Doubles to 1.50 / 7.50 on 2027-01-01. |

Other charges: Anthropic adds a tool-use system prompt of 286 tokens per request on Haiku/Sonnet/Opus 5.5 with `tool_choice: auto`, and `inference_geo: "us"` costs 1.1x (not used). OpenAI states that function definitions bill as input tokens. Batch and flex tiers are irrelevant for interactive chat. Failed requests (4xx/5xx without a response) are not billed by token on any of the three. A model listed in documentation is not proof that our account can use it.

## 3. Capability fit for AgentCore

| Requirement | Anthropic | OpenAI | Gemini |
|---|---|---|---|
| Typed slot extraction | `output_config.format` JSON Schema (Haiku 5.5 supported) | Structured outputs / strict | Structured output + `validated` mode |
| Strict tool arguments | `strict: true` | `strict: true` (all props required, `additionalProperties: false`) | `validated` mode |
| App executes tools | Yes (client tools) | Yes (`function_call_output`) | Yes (`function_result`) |
| Explicit refusal signal | `stop_reason: "refusal"` + category | Refusal field in structured outputs | Finish reasons |
| State model | Stateless; thinking blocks replayed unchanged | Responses API keeps application state 30 days unless `store: false` | Thought signatures must be replayed exactly in stateless mode |
| Usage reporting | input, output, cache read, cache write split by TTL, thinking tokens | Usage objects (not described on the pages read) | Not read |
| Published per-model tool overhead | Yes (exact token counts) | No | No |

Constraints of the chosen model that the adapter implements: Haiku 5.5 rejects sampling parameters and assistant prefill, runs adaptive thinking by default (thinking counts toward `max_tokens`; effort `low` is used), returns empty thinking text, and has no server-side refusal fallback. A refusal becomes a code-side handover.

## 4. Multilingual assessment

No evidence ranks any provider on Uzbek (Latin or Cyrillic), mixed Uzbek/Russian text or apostrophe variants; vendor benchmarks do not cover our case. **The score is equal (unverified) for all three.** What exists is a reproducible harness: 76 cases in [`eval/cases/education`](../eval/cases/education), 19 categories × 4 locales. CI runs them with scripted model outputs, which checks AgentCore's control logic and **not** model quality. `pnpm --filter @agentcore/api eval:live` (opt-in, `LIVE_EVAL=1`, capped by `LIVE_EVAL_BUDGET_USD`, default $0.50 and at most $5) runs the model-independent checks against the real provider on fictional data. Locale packs stay `beta` until that run and native-speaker review happen (D18).

## 5. Cost model

**Units.** A *turn* is one inbound customer message (or a debounced batch) through to its reply or handover decision: every model request in it, including tool rounds and guardrail regeneration. A *conversation* is the sum of its turns.

**Measured prompt sizes** (education pack, Uzbek Latin): extraction system prompt 2,176 B, extraction schema 1,447 B, response system prompt 1,554 B, tool definitions 1,478 B, response user message with search results about 525 B plus results. Token counts below assume ~4 bytes per token for the English instructions and are **estimates**. Cyrillic text uses more tokens per character; heavy scenarios apply 1.5x. Thinking tokens at effort `low` are unknown and are budgeted inside the output figures.

| Turn type | Calls | Input tokens | Output tokens | Haiku 5.5 cost |
|---|---|---|---|---|
| A: question only (extraction; next question rendered by code) | 1 | 1,300 | 300 | $0.00028 |
| B: search + answer | 2 | 2,800 | 550 | $0.00056 |
| C: price with list_offers + live quote | 4 | 7,000 | 900 | $0.00115 |
| D: heavy (long history, 3 tool rounds, one regeneration) | 5 | 14,800 | 1,400 | $0.00218 |

| Scenario | Turns | Per conversation | 1,000 conversations | 10,000 conversations |
|---|---|---|---|---|
| Low | 3 (2A + B) | $0.0011 | $1.12 | $11.20 |
| Typical | 8 (3A + 3B + 2C) | $0.0048 | $4.81 | $48.05 |
| Heavy, valid | 20 (6A + 8C at 1.5x, 6D) | $0.029 | $29.40 | $294 |

Same typical conversation (26,300 input / 4,350 output tokens) on other models: `gpt-6-luna` $0.0048, `gemini-2.5-flash-lite` $0.0044, `gemini-3.1-flash-lite` $0.013, `gemini-3.8-flash` $0.036 (2027: $0.072), `claude-sonnet-5-5` / `gpt-6.1-sol` $0.096, `claude-opus-5-5` $0.19. Prompt caching is not counted: the stable prefixes (~2K tokens) are probably below the model's minimum cacheable length, so caching is a possible later saving, not an assumption. These are LLM token charges only. CRM/connector, hosting and messaging costs are separate and unknown.

**Provisional limits (configurable, not owner-approved budgets):**

| Setting | Default | Rationale |
|---|---|---|
| `LLM_TURN_BUDGET_USD` | 0.02 | About 9x the heavy turn D; caps any turn's worst case (6 calls × full input/output would be ~$0.039). |
| `LLM_CONVERSATION_BUDGET_USD` | 0.25 | About 8.5x the heavy conversation; stops runaway multi-turn loops. |
| `LLM_MAX_CALLS_PER_TURN` | 6 | Extraction + 3 tool rounds + final draft + 1 regeneration. |
| `LLM_MAX_TOOL_ROUNDS` / `LLM_MAX_TOOL_CALLS_PER_TURN` | 3 / 6 | Enough for search → offers → quote. |
| `LLM_MAX_OUTPUT_TOKENS` | 1,024 | Short messenger replies plus low-effort thinking. |
| `LLM_MAX_INPUT_BYTES` | 48,000 | Keeps Haiku well below its 100K-token long-context price. |
| `LLM_TENANT_MONTHLY_BUDGET_USD` | unset | Optional; requires an owner decision. |

Switching STRONG to Sonnet 5.5 multiplies response-call cost about 20x; the heavy conversation (~$0.4 with Sonnet responses) would then exceed the $0.25 default, so the conversation budget must be revisited with that switch.

## 6. Privacy and retention

All three state that paid API data is not used for training by default. OpenAI keeps abuse-monitoring logs up to 30 days, and Responses application state 30 days unless `store: false`; ZDR is by approval. Anthropic: an API help article says inputs/outputs are deleted within 30 days, while a newer API retention page says content is not retained by default except for "Covered Models"; ZDR is by arrangement; flagged content can be kept up to 2 years. Gemini's free tier uses content to improve products, and the paid tier does not. AgentCore sends customer messages, so the production key must be on a paid, commercial plan. The retention conflict on Anthropic's pages must be resolved with the account terms before launch (Open Question 9).

## 7. Weighted evaluation

Scores 1–5. Multilingual is scored equal because no evidence exists.

| Criterion (weight) | Anthropic | OpenAI | Gemini |
|---|---|---|---|
| Tool/structured control (25%) | 5 | 5 | 4 (thought-signature replay burden) |
| Multilingual, unverified (20%) | 3 | 3 | 3 |
| Cost at the cheapest suitable tier (20%) | 5 | 5 | 4.5 |
| Production / SDK / operations (15%) | 4 (SDK 1.1.0 released 2026-10-21) | 5 | 4 |
| Privacy defaults (10%) | 4 | 4 | 3 (free-tier training risk) |
| Price stability (5%) | 5 | 4 (promotional pricing) | 2 (announced 2x increase) |
| Verifiability of the integration here (5%) | 5 | 3 | 3 |
| **Weighted total** | **4.35** | **4.35** | **3.65** |

## 8. Decision and reasoning

Anthropic and OpenAI tie. The decision for Anthropic rests on stated tie-breakers, not on a measured quality difference:

1. **Budget precision:** published, exact per-model tool-use overhead and usage split by cache TTL and thinking, which make the reservation/settlement arithmetic exact.
2. **Stateless API:** fits the durable, replayable processing model; nothing customer-related is held provider-side between calls.
3. **Explicit refusal stop reason**, mapped to a safe handover.
4. **Verifiable implementation now:** the adapter was written against authoritative SDK documentation and the installed SDK's types, and its request shapes are unit-tested.

Disclosure: this evaluation and implementation were produced by a Claude model, so a bias toward Anthropic is possible. The tie is reported as a tie for that reason. **OpenAI (`gpt-6-luna`) is the first alternative**: if the opt-in live evaluation shows better Uzbek quality or tool reliability, an OpenAI adapter can be added behind `LlmProvider` without core changes.

**Model strategy:** one model, `claude-haiku-5-5`, for both FAST and STRONG. A second model is not introduced without evidence. STRONG can be set to `claude-sonnet-5-5` by configuration if live results show Haiku is insufficient for tool selection or reply quality. There is no automatic fallback to another provider or model; failures degrade to code-rendered replies or a handover.

Rejected: Opus 5.5 (40x the cost for a short-reply workload, with no evidence it is needed); Gemini (equal multilingual uncertainty, thought-signature state handling, and an announced price doubling for Flash on 2027-01-01); a self-hosted model (no evaluation or operations evidence, and higher operational load).

## 9. Unverified

- Any live request with a real key, actual latency, rate limits on our account, and whether `claude-haiku-5-5` is enabled for the account.
- Uzbek, Russian and English quality, mixed-language handling and tool-selection accuracy of any model.
- Real token counts per turn (the estimates above come from byte sizes) and thinking-token volume at effort `low`.
- Data retention terms of the actual Anthropic account.

## 10. OpenAI-compatible endpoints (free and local testing), verified 2026-10-23

These facts come from official documentation and back the generic `openai-compatible` adapter. They are not a provider decision: Anthropic remains the production choice (ADR 008).

| Fact | Source | What the source says |
|---|---|---|
| Chat Completions endpoint, `tool_choice` default | [OpenAI create chat completion reference](https://developers.openai.com/api/reference/python/resources/chat/subresources/completions/methods/create) | Endpoint `POST /chat/completions`. "`auto` is the default if tools are present." `max_tokens` is "Deprecated… in favor of `max_completion_tokens`". `response_format` `json_schema` "enables Structured Outputs"; `json_object` is "the older JSON mode". The response example shows `usage.prompt_tokens`, `completion_tokens` and `prompt_tokens_details.cached_tokens`, and `tool_calls[].function.arguments` as a JSON string. |
| Quota vs rate limit | [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes) | 429 "Rate limit reached for requests": follow Retry-After. 429 "Credit balance exhausted", code `credit_balance_exhausted`, with `error.type` possibly `insufficient_quota`: retrying will not restore access. 503 `server_is_overloaded`: retry. |
| Gemini OpenAI compatibility | [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) | Base URL `https://generativelanguage.googleapis.com/v1beta/openai/` with `Authorization: Bearer`. Tools use the OpenAI `function` shape with `tool_choice: "auto"`. Support is "still in beta". The page does not mention `json_schema`, `max_tokens` or `parallel_tool_calls`. |
| Gemini rate limits | [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) | Limits are RPM, TPM (input) and RPD; "RPD quotas reset at midnight Pacific time". The spend-limit error is `429 RESOURCE_EXHAUSTED`. Free-tier per-model numbers are not on the page; they are shown per account in AI Studio. |
| Gemini free tier and data use | [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) | Free Tier input and output are "Free of charge" for, among others, `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash` and `gemini-2.5-flash-lite`. "Used to improve our products": Free Tier "Yes", Paid Tier "No". `gemini-4-argon` and `gemini-3.1-pro-preview` have no Free Tier. |
| Ollama OpenAI compatibility | [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) | Base URL `http://localhost:11434/v1/`. An API key value is required by clients "but Ollama ignores it". `tool_choice` is listed as unsupported; tools, JSON mode, `response_format` and `max_tokens` are supported. The page does not state that `prompt_tokens` and `completion_tokens` are returned. |

### How the facts shape the adapter
- **`tool_choice`** is never sent: it defaults to `auto`, and Ollama rejects it.
- **The output-ceiling parameter is configurable,** because the docs disagree: `max_tokens` is deprecated by OpenAI but is the one Ollama documents.
- **Structured output** falls back from `json_schema` to `json_object` by configuration. Zod validation is authoritative either way.
- **Gemini 429s are treated as rate limits** (retryable, honoring Retry-After), because `RESOURCE_EXHAUSTED` does not distinguish quota from rate. The configured RPD limiter guards the daily quota.
- **Usage is estimated and flagged** when a server returns none.
- **Free-tier limits** are configured, not built in.

### Not verified
- **No live request** was made to Gemini or Ollama, because no key or local server was available. Whether Gemini's compatibility layer accepts `response_format: json_schema` and `max_tokens` is not documented. If it does not, set `LLM_STRUCTURED_OUTPUT=json_object` or `LLM_MAX_TOKENS_PARAM`.
- **The 400-message pattern** used to classify "unsupported feature" errors is a heuristic, not a documented error code.

## 11. Integration targets and Stage B provider facts (verified 2026-10-23)

### Three separate targets
1. **Claude Code (the coding assistant).** [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway): "Anthropic ... doesn't support routing Claude Code to non-Claude models through any gateway", and a gateway must expose a supported Anthropic-format API. None of the providers below offers that, so **none is configured for Claude Code**; its model stays `sonnet` (`.claude/settings.json`) with the Opus 5.5 ceiling.
2. **AgentCore `LlmProvider`** (production agent). Presets in `apps/api/src/llm/provider-presets.ts`, used directly (`openai-compatible`) or through the failover router (`LLM_PROVIDER=routed`, ADR 012).
3. **A gateway/proxy:** not built.

### Providers (AgentCore target only; all `trusted: false`)
| Provider | Protocol / base URL / key var | Tools | Structured output | Limits and data use (source) |
|---|---|---|---|---|
| Groq | Chat Completions, `https://api.groq.com/openai/v1`, `GROQ_API_KEY` ([docs](https://console.groq.com/docs/openai)). Unsupported fields (400): `logprobs`, `logit_bias`, `top_logprobs`, `messages[].name`. | All listed models; parallel use not on gpt-oss ([tool use](https://console.groq.com/docs/tool-use)) | Strict `json_schema` only on gpt-oss-20b/120b, qwen3.8-27b, muse-spark-open; others JSON object ([structured outputs](https://console.groq.com/docs/structured-outputs)) | gpt-oss-120b: 30 RPM, 1K RPD, 8K TPM, 200K TPD, but the page labels the table "Developer plan" ([rate limits](https://console.groq.com/docs/rate-limits)); 429 carries `retry-after`. Data use not read. |
| Gemini | OpenAI compatibility (beta), `https://generativelanguage.googleapis.com/v1beta/openai`, `GEMINI_API_KEY` ([docs](https://ai.google.dev/gemini-api/docs/openai)) | `tool_choice: auto` documented | `json_schema` only via a parse() example | Per-account limits in AI Studio; Free Tier "Used to improve our products: Yes" ([pricing](https://ai.google.dev/gemini-api/docs/pricing)) |
| OpenRouter | Chat Completions, `https://openrouter.ai/api/v1`, key var `OPEN_ROUTER_API_KEY` ([docs](https://openrouter.ai/docs/api-reference/overview)) | per model | per model | `:free` variants: 20 RPM, 50 RPD (1000 RPD with 10+ credits) ([limits](https://openrouter.ai/docs/api-reference/limits)); 402 insufficient credits, 429 rate limit ([errors](https://openrouter.ai/docs/api-reference/errors)) |
| Mistral | `https://api.mistral.ai/v1`, `MISTRAL_API_KEY` ([API](https://docs.mistral.ai/api/)) | `tool_choice` auto/none/any/required | `json_object` and `json_schema` | Free-tier page not found (404); model ids are examples only |
| LLM7.io | `https://api.llm7.io/v1`, `LLM7_API_KEY` ([quickstart](https://docs.llm7.io/quickstart.md)) | "depends on the selected model" (Models API flag `tools_calling`) ([function calling](https://docs.llm7.io/guides/function-calling.md)); no free-tier restriction stated | JSON mode `json_object` only, per model flag `json_mode`; `json_schema` not documented ([JSON mode](https://docs.llm7.io/guides/json-mode.md)) | Free token: 1 req/s, 60/min, 250/h, 100,000 tokens per 24 h, "may be reduced without notice" ([limits](https://docs.llm7.io/limits.md)); no privacy page found |

### Measured on this project's accounts
See [LLM_PROVIDER_STATUS.md](LLM_PROVIDER_STATUS.md). Groq `openai/gpt-oss-20b` and Gemini `gemini-3.5-flash-lite` showed chat, tool calls and json_schema; Mistral was rate-limited; OpenRouter and LLM7 were not tested.

### Not verified
- Groq and Mistral data-use terms; OpenRouter and LLM7 model ids and prices; Mistral free-tier limits; whether the Groq table is the free plan.
- LLM7 is an **optional candidate**: it is configured with no default model, no capability beyond `json_object`, and is not in the default routing policy.
