# 05 — LLM outage or bad answers

The model is reached through the provider abstraction (D15). Settings are in `/opt/tezda/deploy/.env.production` (`LLM_PROVIDER`, keys and models; the `routed` provider can fail over between configured providers, see `docs/LLM_PROVIDER_EVALUATION.md` and `docs/LLM_PROVIDER_STATUS.md`). Until real keys are added the API stays at its default provider.

## What happens by design
- A provider error or timeout ends the turn through the failure policy: the customer is handed to a human (no invented answer, no silence). A sudden rise in handovers or in `FALLBACK` reasons is the first sign.
- Guardrails (D5) block a draft that contains an unsourced number; the turn then hands over. This is not an outage.
- An untrusted provider is limited to test accounts unless the owner consents (data-protection guard); changing the provider can therefore silently put an account on `HOLD`. The Bot page shows the effective mode and the reason.

## Steps
1. Confirm it is the provider and not us: `dc logs --since 15m api | grep -E 'llm\.|provider'` for timeouts, 401/403 (bad or expired key), 429 (rate limit or budget), 5xx (vendor outage). Check the vendor status page.
2. **Bad key or budget:** replace the key in `.env.production` on the host (never in git, never in chat), then `dc up -d api` so the container is recreated with the new file. Do not print the value: check only that the variable name is present.
3. **Vendor outage, no failover configured:** keep the bot answering only what it can: set the affected channels to off in the Bot page so customers wait for a human, or leave it and let handovers happen. Tell the operators the handover count will be high.
4. **Switch provider:** change `LLM_PROVIDER` (and its keys) in `.env.production`, `dc up -d api`, then watch the Bot page for `HOLD` caused by the trust policy. Test on a test account first.
5. **Bad quality after a change** (wrong language, odd answers): set the channels to `SHADOW` (the bot drafts, nobody is answered) while you check; compare with the eval gate locally (`pnpm test:eval`, mock models only) before blaming the model.

## Verify
A test question on the Telegram test bot gets a correct grounded answer in the customer's language, handover share returns to the usual level, and no 4xx/5xx from the provider in the last 10 minutes.

## Known limits
Cost per turn is tracked but there is no automatic switch-over on a budget breach; plan limits such as `monthlyLlmBudgetUsd` are not enforced yet (roadmap P2.9). The paid price list in `pricing-catalog.ts` expires 2026-12-31 and nothing checks that yet.
