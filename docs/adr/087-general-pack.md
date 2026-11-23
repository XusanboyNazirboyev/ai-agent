# ADR 087 — A general sales and service pack for every other business

Status: accepted by the owner on 2026-11-23 ("1+2+3 now, then the general pack"; ADR 086 is steps 1–3).

## Context
- Only two packs existed (education, travel). ADR 086 stopped giving every signup the education pack, but "other business" could not sign up at all.
- Options weighed: (a) a pack per vertical: each one is weeks of slots, wording, CRM template and 100+ eval cases, so it does not scale to "any business"; (b) one general pack: works for any catalog today, asks less specific questions; (c) tenant-editable questions on top of a pack: the most flexible, but needs a UI, validation and its own eval gate; (d) an LLM drafting a pack per tenant: unpredictable, needs review, and invented questions are a quality risk. Chosen: (b) now; (c) next, built on (b); vertical packs only where the flow really differs (travel, education, later appointments).

## Decisions
1. **`general@1` pack** (`apps/api/src/packs/general/`): item type `item`; two slots, `need` (the product or service in the customer's words, the title search) and optional `quantity`; prompt rules: describe only what the catalog returned, never promise delivery, stock or results not confirmed; CRM template `sales` with the agent's staging codes (NEW … NEGOTIATION, WON, LOST, ADR 058) and lead fields need and quantity; action `order_request` (createLead: need, quantity, name, phone; explicit confirmation; external reference shown).
2. **Signup:** "Other business (shop, services)" now creates a `general` tenant (it was "coming soon").
3. **Sheet catalogs serve any pack:** the spreadsheet connector stored every row as `tour`, so an education or general tenant's sheet search found nothing. A tenant's sheet is one catalog, so its search no longer filters by item type.
4. **Order claims are false-success claims too:** the guardrail caught "booking confirmed" but not "your order is confirmed / buyurtmangiz tasdiqlandi / заказ подтверждён". Order stems added to every locale pack.
5. **Eval (D14):** `eval/generate_general_cases.py` writes 33 single-turn and 17 lifecycle cases per locale (uz-Latn, uz-Cyrl, ru, en: 200 in all) on a fictional shop and service catalog (`mock-general`), covering every required and blocking group; the coverage gate now includes `general`.

## Consequences
- A shop, salon or service centre can sign up and be served from its own catalog; questions are generic until tenant-editable questions exist.
- Not verified: a live-model run of the general pack (scripted eval only); native-speaker review of the new wording (locales stay beta).
