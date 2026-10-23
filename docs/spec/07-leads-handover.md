## 8. LEAD CAPTURE, SCORING, LOSS PREVENTION

- Scoring: deterministic rules from the Domain Pack first, LLM structured output (`intent`, `urgency`) second; code applies final rules; always store `reasonCodes[]` (e.g., `PHONE_PROVIDED`, `CONCRETE_ITEM`, `ASKED_TO_BOOK`, `URGENT_DATE`). Levels: HOT / WARM / COLD.
- Ask for a phone number **after delivering value**, framed as a benefit.
- **Never lose a lead on failure**: if LLM or connector fails, send a safe acknowledgment (localized template) and persist the lead to a retry queue.
- Follow-ups for unanswered conversations: Telegram (respect blocks/opt-outs); Instagram/WhatsApp must obey Meta's messaging-window/template rules. **[OPEN: verify current official rules before implementing.]**
- After-hours: bot answers; a morning digest lists hot/warm leads for operators.
- Operator SLA: if a handover is not picked up in N minutes (configurable), alert operators and tell the customer an operator will reply soon.
- Voice messages (speech-to-text) and images (image understanding) from Phase 6, subject to Open Question 8.

---
