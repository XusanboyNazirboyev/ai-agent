# ADR 067: Ready CRM templates from the domain pack (tourism first)

Status: accepted 2026-11-15 (UX review step 7; first pilot is a travel agency).

## Problem
A new travel agency starts with the generic funnel (New, Contacted, Qualified, Proposal, Negotiation, Won, Lost) and no lead fields or tags of its own. Setting up stages, fields and tags by hand is the kind of setup a non-technical owner does not do.

## Decision
- A domain pack may carry a **`crmTemplate`** (shared `CrmTemplateSchema`): a pipeline name per locale, ordered stages by **code and kind** (exactly one LOST, at least one OPEN, unique codes), lead fields (key, type, label per locale) and tags (name per locale, colour). It is data, so nothing vertical-specific enters the core (rule 1). The travel pack carries the **tourism** template: Inquiry, Offer sent, Prepayment, Documents and visa, Paid (won), Travelled (won), Lost; fields destination, departure date, travellers, budget per person, needs a visa or passport; tags Family, Honeymoon, Hot tour.
- **Applied on purpose only**: `GET /api/v1/crm-template` shows it in the workspace language with what already exists; `POST /api/v1/crm-template/apply {makeDefault}` (OWNER, ADMIN) creates, in one transaction under the tenant lock, the pipeline with its stages (unless a non-archived pipeline of that name exists), the fields whose key is free (an archived field counts as taken) and the tags whose name is free (case-insensitive, like the tag index). Nothing existing is changed or removed; applying twice adds nothing. With `makeDefault` the new pipeline takes new leads; existing leads stay where they are; the old default keeps a stored name, as in make-default.
- Stage **names come from codes**, translated by the web catalog in the viewer's language (`leads.stage.INQUIRY` ...); field labels and tag names are stored in the workspace's default language, because those entities hold one name.
- Also in this step: the travel pack's month slot covers the whole year (it stopped at June to August), and the Sales stages page no longer shows a raw stage code next to each stage; "AI staging" is worded as a question ("The assistant moves leads: No, only people / It suggests, a person confirms / Yes, by itself").

## Not chosen
- Creating the template automatically for every travel workspace: it would change a workspace the owner already set up; applying is one click.
- Overwriting or merging into the default pipeline: leads already sit in its stages.

## Verified
6 integration tests (view in the workspace language, apply with and without making it the default, idempotent second apply, existing archived field and differently cased tag kept, roles and no-template workspace, pipeline limit rolls everything back, another workspace untouched) with 5 mutations caught; 3 unit tests (the travel template in every pack locale, 12 months with Uzbek and Russian spellings, the schema refusing unusable templates); 3 browser tests with the template faked (the e2e workspaces are education ones). Not verified: with the pilot agency; whether these stage names match how they work (usability test, step 9).
