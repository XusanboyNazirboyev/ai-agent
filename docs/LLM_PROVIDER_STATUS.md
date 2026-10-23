# LLM provider status (smoke test)

Run 2026-10-23. Three tiny calls per provider (chat, one tool call, one JSON-schema output), max 200 output tokens each. Results are a point-in-time observation of THIS account; they do not prove behavior under load or on other models. Fake data only.

| Provider | Model | Chat | Tool call | json_schema | Latency ms | Tokens in/out | Usage reported |
|---|---|---|---|---|---|---|---|
| groq | openai/gpt-oss-20b | ok | yes | yes | 2336 | 394/287 | yes |
| gemini | gemini-3.5-flash-lite | ok | yes | yes | 19416 | 81/24 | yes |
| openrouter | — | skipped: no default model; set SMOKE_MODEL_OPENROUTER | | | | | |
| mistral | mistral-small-latest | LLM_RATE_LIMITED | LLM_RATE_LIMITED | LLM_RATE_LIMITED | 0 | 0/0 | yes |
| llm7 | — | skipped: no default model; set SMOKE_MODEL_LLM7 | | | | | |

Codes such as `LLM_RATE_LIMITED` or `LLM_INVALID_REQUEST` are the typed error the adapter raised; `no` means the call succeeded but the capability was not shown.

## Observations (2026-10-23, this project's accounts)
- **Groq:** `llama-3.1-8b-instant` is listed in Groq's tool-use docs but returned `model_not_found` for this account (HTTP 404); `openai/gpt-oss-20b` passed all three checks. Model availability is per account.
- **Gemini:** `gemini-2.5-flash-lite` is "no longer available to new users" (HTTP 404; the API names `gemini-3.5-flash-lite`). `gemini-3.1-flash-lite` returned 503 "high demand" on repeated tries. `gemini-3.5-flash-lite` passed, but slowly (about 6 to 11 s per call); keep `LLM_REQUEST_TIMEOUT_MS` at or above 20000.
- **Mistral:** HTTP 429 "Rate limit exceeded" on the first call, every run. Free-tier limits for this account are unknown (docs page returned 404), so Mistral is not in the default routing policy and has no priced model.
- **OpenRouter, LLM7:** not tested (no verified default model id). Set `SMOKE_MODEL_OPENROUTER` / `SMOKE_MODEL_LLM7` and rerun `pnpm llm:smoke openrouter llm7`.

