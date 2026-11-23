# ADR 086 — Safe tenant onboarding: business type, business profile, go-live gate

Status: accepted by the owner on 2026-11-23 (chat: "1+2+3 now, then a general pack"; first customers are travel agencies).

## Context (read from the code on 2026-11-23)
- Self-serve signup created every tenant with the first registered pack (`signup.service.ts`: `[...DOMAIN_PACKS.values()][0]`, i.e. education). A travel agency or a shop was asked course questions ("which subject?").
- The agent never received the business's own name, address or phone (prompts carry only `pack.prompt.businessRole`), and no rule forbade guessing them: a bot could invent its agency's name or phone.
- Hard facts were already safe (D1/D5): prices come only from the tenant's catalog connector, the selector only uses the tenant's own ACTIVE connectors, and no catalog means a handover. But a channel could be switched LIVE with no catalog, or with the fictional demo (`mock`) catalog, which is what the staging test tenant runs on.

## Decisions
1. **Business type at signup.** The form asks Travel agency / Training centre / Other. The API requires `packKey` from `SIGNUP_PACK_KEYS` (one per registered pack key) and creates the tenant with that pack (`packByKey`, newest version). "Other" cannot be sent until a pack fits it. Additive migration `pending_signups.pack_key` (nullable: signups already in flight keep the old behaviour).
2. **Business profile.** `tenant.name` plus `tenant.config.profile {address, phone, hours, website}`, edited on the AI bot settings page (`GET/PUT /api/v1/business-profile`, PUT OWNER/ADMIN only, audited with field names, never values). Each filled field is a reserved fact (`F901` name … `F905` website, `FactStore.addProfileIfReferenced`, kind `knowledge`, source `business_profile`): the model writes only the reference and code renders the stored text, like the clock fact `F0`. A new prompt rule (response rule 10 and the conversational rules) says never to write or guess these details and to say an operator will confirm any detail not on file. A reference to an empty field is an unknown fact, so the guardrail rejects the draft; a phone typed by the model is rejected as before (digits).
3. **Go-live gate.** Switching a channel to LIVE (the only path is `PUT /api/v1/channels/:id/agent-mode`; new accounts start OFF) is refused with `SETUP_INCOMPLETE` and `missing: CATALOG|PROFILE` unless the pack's catalog role resolves to a real connector (the `mock` demo catalog counts only for a test account) and the profile has the name and phone. SHADOW and OFF are not gated; an account already LIVE is not re-checked. The bot page lists what is missing (`GET /api/v1/business-profile/readiness`).
4. **Next (not in this ADR):** a general sales/service pack for other businesses and tenant-editable questions, so a new business type is configuration, not code.

## Consequences
- Core change (`core/agent/facts.ts`, `prompts.ts`, `agent-turn.ts`) is generic: no vertical or CRM words (rule 1).
- Tool fact ids now stop below 900 (`FactStore.add` throws at the reserved range; tool calls are capped far below it).
- Tests: signup integration (pack stored and used; missing/unknown type refused), business profile unit (render, unknown reference rejected, typed phone rejected, prompt rule) and integration (roles, validation, config kept, audit without values), go-live integration (no catalog/profile, demo catalog, test account, SHADOW not gated, LIVE not re-checked), web form and card tests.
- Not verified: a live model run that answers "what is your address?" with the profile reference (the eval suite has no such case yet).
