# ADR 065: Test chat — try the assistant without a customer

Status: accepted 2026-11-14 (owner order of work, UX review C3). Implemented on `feat/ui-words-menu`.

## Problem
An admin cannot see what the assistant will say before a real customer does. The only way to try it is to message the real Telegram bot, which creates a real contact, conversation and perhaps a lead and a handover, and pings the operator group.

## Decision
A **test chat** inside the app, for OWNER and ADMIN only (`POST /api/v1/assistant/test-chat`).
- **The dialogue lives in the browser.** Every request carries the typed text, the earlier turns (at most 30, each at most 2,000 characters), the collected details and the language. The server keeps nothing between messages.
- **No conversation data is written**: no conversation, contact, message, slot, turn, handover or lead row exists afterwards, nothing is sent to any channel, no business action or appointment is offered. This is enforced inside `AgentConversationService.compute` by a `sandbox` input: history, slots and language come from the request, and every read of stored conversation state is skipped.
- **The real tools run**: catalog search, price list, quotes and the knowledge base answer from the tenant's own data, with the same guardrail and rendering by code. Prices therefore come from the price list exactly as for a customer (D1, D5).
- **Cost is metered** like any turn (usage rows with the sandbox id as the metering key; the tenant monthly budget stays the hard limit). A person may send 10 messages a minute (in memory, per process: a restart or a second process loosens it; the budget is the real cap).
- **Trust:** the client-held history is untrusted text like any customer text (D8): it only shapes the model's context; facts are rendered by code from tool results with provenance bound to the sandbox id. Admin typing counts as test data for the knowledge embedding rule (a customer never types here).
- The response carries the reply, the outcome, a **handover reason** when the assistant would pass the chat to a person, the tools it used (names), the details it collected and the language to send back next turn.
- One audit row `assistant.test_chat_used` (counts only, no text) is written for the first message of a chat; the getting-started list on Today uses it to show "Try the assistant" as done.

## Not chosen
- A hidden test conversation in the database: it would reach the inbox lists, analytics, contacts, exports, follow-ups (which could message the test contact) and retention; every one of those would need a filter, and a missed one would be a real defect.
- A fake channel account: same leaks, plus a new channel type that the connect and send code would have to know.

## Verified
3 integration tests of the sandbox (no rows written, history and slots from the request never from a stored conversation, unknown workspace refused) with a mutation that reads stored slots caught; 4 API tests (reply and tools, roles and body validation before any model call, rate limit per person, configuration error) with mutations on the role check, the rate limit, the audit-once rule and the history cap caught. The existing agent integration tests pass unchanged.
Not verified: a real model (tests use the scripted provider); `readOnly: true` set by the controller is redundant with the sandbox rule (the scheduling tools are withheld by the sandbox itself), kept as defence in depth.
