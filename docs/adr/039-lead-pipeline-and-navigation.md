# ADR 039: Tenant-configurable lead pipeline and navigation

- **Status:** Accepted (uncommitted on `feat/dev-mock-connector`)
- **Date:** 2026-11-06

## Context

The operator UI needs one place for lead/contact work and a pipeline that can fit businesses whose lead stages differ. Existing AI lead scores (`HOT`, `WARM`, `COLD`) are classification signals, not a workflow state.

## Decision

- Keep AI score separate from the tenant-owned pipeline stage. Seed `NEW`, `HOT`, `WARM`, and `COLD` as initial stages; assign new leads to `NEW`, and do not move a lead's stage when its score changes.
- Allow tenant owners/admins to add and rename stages. Tenant-scoped API operations govern stage access and lead movement.
- Put Contacts in Leads, with List and Funnel views. Put the existing Bot and Channels pages under Settings, alongside pipeline-stage and general settings.
- Order conversation scopes as All, Waiting, Closed, with All selected by default and no Mine scope.
- CRM setup is not added here: this checkout has no CRM setup page to relocate, and the requested change was limited to reorganizing features present at this HEAD.

## Consequences

- Tenants can use workflow stages without changing the model's independent AI classification.
- Existing leads are mapped into the seeded stages by their current score during the additive migration; new leads begin at `NEW`.
- Stage deletion/reordering and a CRM setup UI remain outside this change.
