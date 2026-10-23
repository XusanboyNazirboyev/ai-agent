## 6. MULTILINGUAL DESIGN

### 6.1 Concepts
- **Language** (Uzbek, Russian, English, Karakalpak, Tajik) vs **script** (Latin, Cyrillic). Uzbek is commonly written in both; customers also mix languages (Uzbek + Russian words) and use inconsistent apostrophes (`o'`, `o‘`, `oʻ`, `o’`, `o`).
- Detect `{language, script, confidence}` per message (lightweight detector + LLM fallback for short/mixed text). Persist the conversation's preferred language/script; switch when the customer switches.
- **Reply in the customer's language AND script.** Never answer Cyrillic Uzbek with Latin Uzbek unless the customer switches.

### 6.2 Locale Pack (one per language; adding a language = adding a pack, no core change)
Contains: `code` (BCP-47, e.g., `uz-Latn`, `uz-Cyrl`, `ru`, `en`, later `kaa`, `tg`), `status` (`stable` | `beta` | `planned`), system prompt fragments, tone/politeness rules (e.g., respectful "siz" form in Uzbek), message templates (greetings, acknowledgments, handover notices, error fallbacks), number/date/currency formatting, transliteration rules, slot-question templates for each pack, and locale eval cases.

### 6.3 Search and matching across scripts
- Normalize text for matching: apostrophe unification, case folding, **Uzbek Latin↔Cyrillic transliteration** (implement and unit-test rigorously; handle `o‘ g‘ sh ch ng`, soft/hard signs, and Russian loanwords).
- Store normalized forms of catalog titles/aliases in an indexed column so "Анталия", "Antalya", "Анталья" all hit the same item; maintain a per-tenant **synonyms/aliases** table.
- Use a **multilingual embedding model** for knowledge retrieval and test cross-lingual retrieval (question in Uzbek, document in Russian).
- Hard facts are never translated by the LLM: they are rendered by code (D5) with locale formatting.

### 6.4 Launch scope
- **v1 launch languages [OPEN, confirm]: Uzbek (Latin + Cyrillic), Russian, English** = the "3 most needed". 
- **Planned (not v1)**: Karakalpak, Tajik (and any others). Their locale packs ship as `planned`/`beta` only after the process below.
- Process to add a language: (a) create locale pack, (b) write ≥50 eval cases with a native speaker, (c) native-speaker review of templates/prompts, (d) measure against the threshold, (e) mark `beta` (conservative: lower handover threshold, always offer operator), (f) after the threshold is consistently met → `stable`.
- Lower-resource languages (e.g., Karakalpak, Tajik) may have weaker LLM quality, speech-to-text support, and fewer resources; **do not claim support before eval proves it** (D18). Until then, detect the language and reply with a safe template plus offer a fallback language or operator.
- Operator-side: handover summaries are written in the operator's configured language, regardless of the customer's language.

---
