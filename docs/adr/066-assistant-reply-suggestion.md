# ADR 066: Assistant suggestion for the operator (reply draft)

Status: accepted 2026-11-14 (owner's choice of a separate card, UX review D1).

## Problem
An operator writes every reply from scratch, also when the assistant already knows the answer from the price list or the knowledge base.

## Decision
On request, the assistant drafts a reply to the customer's **last message** and shows it in a separate **"Assistant suggestion" card** above the reply box. The operator sends it as it is, edits it first (the text moves into the reply box) or dismisses it. It never fills the reply box by itself and never sends anything by itself.
- `POST /api/v1/inbox/conversations/:id/suggest-reply`, OWNER, ADMIN and OPERATOR (not VIEWER), the conversation must be in the session's tenant and not closed.
- It is the **same turn the customer would get** (`AgentConversationService.compute`: same tools, guardrail, facts from tool results with provenance, prices rendered by code), run **read only**: no message, turn, slot, handover or lead is written and nothing is sent. The history is read from the stored messages strictly before the answered customer message. The cost is metered (turn key `suggest-…`).
- When the assistant itself would hand the chat over, the answer is only the reason (the "a person will answer" text is useless as a draft for the person).
- **On request, not automatic:** every suggestion is a paid model call; an automatic suggestion on every message would multiply the cost. A person may ask 6 times a minute (in memory, per process; the tenant budget is the hard cap).
- The card says the suggestion is **stale** when the customer wrote again after the message it answers, and offers a new one. Nothing sent from a stale card is blocked: the operator decides.
- The facts in a suggestion are as trustworthy as an assistant reply (D1, D5), but the operator, not the assistant, sends it: the card tells them to read it first.
- Also here (code only, no model): the handover card opens with a two-line headline, what the customer asked for and what they said, built from the stored summary with translated labels.

## Not chosen
- Filling the reply box automatically: a hurried operator may send an unread draft; the owner chose the separate card.
- Storing suggestions: no use for them, and they would carry customer text a second time.

## Verified
4 integration tests (draft answers the newest customer message and changes no row, hand-over gives a reason and no text, viewer / other workspace / closed chat / nothing to answer refused before any model call, rate limit) with 6 mutations caught (role, tenant scope, closed, rate, hand-over text, which message is answered). Not verified: a real model; how operators use it (usability test, step 9).
