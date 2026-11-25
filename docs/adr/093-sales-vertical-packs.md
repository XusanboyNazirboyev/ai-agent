# ADR 093 — Sales packs for appliances, vehicles, property and services

Status: implemented locally for review on 2026-11-25.

## Decision

Register four versioned packs and expose them in business-type selection:

| Pack | Required catalog search slot | Optional customer preferences |
| --- | --- | --- |
| `home-appliances@1` | Appliance type or model | Quantity, budget |
| `auto-sales@1` | Vehicle make, model or type | New/used preference, budget |
| `real-estate@1` | Property type or listing | Preferred location, room count, budget |
| `services@1` | Service name or category | Service area, preferred time |

The packs use the existing `item` catalog type. Use a compatible tenant catalog
with searchable product, listing or service titles. Optional preferences go in
the lead requirements. They are not hard filters on catalogs that lack the
corresponding attributes. Each pack offers an optional CRM template with
localized field labels and the standard sales stage codes.

Catalog reads and ordinary lead intake use the existing engine. There are no
new automated purchase, booking, viewing or test-drive actions. Prices and
availability require tool evidence. The team handles unverified terms and
requests requiring human confirmation. New packs introduce no CRM provider
or schema migration. Existing workspaces keep their current pack.

## Verification and release

Focused scripted cases cover all four locales and exercise clarifying
questions, confirmed pricing, rejection of invented prices, missing inventory,
lead evidence and handover. They exercise core behavior with synthetic inputs.
A complete launch-level evaluation (including dataset diversity and live
model behavior) and native-speaker review still need to be completed before
the new packs are treated as production-validated.
