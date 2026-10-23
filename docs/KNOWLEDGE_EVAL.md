# Cross-lingual retrieval check (live, fictional text)

Run 2026-10-23 (UTC 20:47) with `LIVE_KNOWLEDGE_EVAL=1 KNOWLEDGE_EMBEDDINGS=gemini KNOWLEDGE_EMBEDDING_MODEL=gemini-embedding-2 pnpm --filter @agentcore/api knowledge:eval`. Provider `gemini` (OpenAI-compatible `/embeddings` endpoint), model `gemini-embedding-2`, key from the git-ignored `.env`, never printed. Fictional text only (`eval/knowledge/cross-lingual.json`: six invented education-center policies, each in English, Russian and Uzbek Latin; 18 questions, six per language). One request with 36 texts, 2.9 s, input tokens not reported by the provider. Free tier: no cost incurred (pricing page lists free input for this model; free-tier content is used to improve Google's products, hence fictional text only).

| Query language -> index language | Top-1 correct |
|---|---|
| en -> en, en -> ru, en -> uz | 6/6 each |
| ru -> en, ru -> ru, ru -> uz | 6/6 each |
| uz -> en, uz -> ru, uz -> uz | 6/6 each |

**What this shows:** for this model, on a six-document index with clearly distinct topics, the right document ranked first in every language pair, including question in Uzbek against a Russian-only index (the case named in the spec).

**What it does not show:** accuracy on real documents or large indexes, near-duplicate documents, typos or slang, Uzbek Cyrillic, other models, or the effect of chunking. The Uzbek and Russian wording was written for this check and not reviewed by a native speaker. It is a smoke test of cross-lingual ability, not a quality measurement; deterministic CI uses a hashing embedder that has no cross-lingual ability and tests only plumbing.
