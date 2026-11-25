# ADR 094 — Furniture sales pack and shared onboarding metadata

Status: implemented locally for review on 2026-11-25.

## Decisions

1. `furniture@1` uses the existing tenant catalog, knowledge and lead engine.
   A product type, model or SKU starts a catalog search. Dimensions with units,
   material, finish, quantity, delivery area and budget are buyer requirements.
   They are kept separate from verified specifications and from the title query.
2. The pack guides extraction to hand off made-to-measure requests, site
   measurements and custom estimates to the team. The ready-made item's price
   cannot be presented as a custom estimate. No new purchase, reservation,
   delivery or installation action is available. The CRM template uses the
   standard sales stages and localized requirements fields.
3. `GET /api/v1/public/signups/options` publishes pack keys and localized labels
   from the same registry that validates signup. Future packs need a pack and
   registration entry. The signup page has no separate list of business types.
   The endpoint serves static public metadata without accessing tenant data.
4. The catalog import supports a price basis per uploaded list. The selected
   basis is stored in the existing catalog options and applies to both listed
   offers and fresh quotes, including after refresh. Existing lists without a
   basis still use the historical per-person default. The importer recognizes
   product-name and inventory-count headings in English, Russian and Uzbek.
   Per-unit rows with distinct SKUs remain separate even when their titles
   match. An exact SKU match outranks a title match. No migration is needed.

## Pilot setup

- Select the furniture pack for an isolated workspace.
- Import the merchant's actual price list with a stable code/SKU, title, price,
  currency and stock count where known. Choose **Per unit** for prices that
  represent one item. A list has one price basis. Use a different SKU for each
  stocked variant and a descriptive title for customers searching by name.
- Add verified showroom, delivery and installation policies to the workspace
  knowledge base. An absent or expired price list does not authorize a quote.
- Review ready-made price and stock, a sold-out product, and a custom request
  in the operator inbox before a live pilot. Validate non-English catalog
  wording with the merchant. The production connector integration tests use
  disposable test data. A live merchant catalog and model are not verified.

Deployment should update API and web together. The signup UI relies on the
new options route. Direct AI sales stays paused.

Review note (2026-11-25): a custom-furniture request is handed over when the
extraction model classifies it as `human_request` (the pack's role text asks
for that), the same intent-then-code path as every other handover trigger.
The tests script that intent; whether a live model classifies made-to-measure
and quote requests that way is not verified yet and belongs in the launch
evaluation. Catalog prices still come only from tool results, so a
misclassified request can show a listed ready-made price but never an invented one.
