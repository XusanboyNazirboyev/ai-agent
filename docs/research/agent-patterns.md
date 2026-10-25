# Agent platform patterns — competitive research (Stage 0)

Read 2026-10-25 from public pages only (no accounts, no data entered). We take **patterns and ideas only**; no text, UI, branding or code is copied. Anything a researcher could not confirm on a public page is marked *unverified*. Channel rules are in [channel-rules.md](channel-rules.md).

## Pattern matrix
✓ = documented on a public page, ~ = partial/thin evidence, ? = not found / unverified, — = not offered.

| Capability | respond.io | reveo.uz | Intercom Fin | Zendesk AI | Botpress | Voiceflow | Sierra | Decagon | ManyChat | Kommo | Wati | Lyro |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Agent templates / persona (role, tone, instructions) | ✓ | ~ | ✓ | ~ | ~ | ✓ | ✓ | ✓ | ? | ~ | ~ | ~ |
| Procedures / playbooks (multi-step, NL + deterministic) | ~ (workflows) | ? | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ (flows) | ✓ (Salesbot) | ~ | — |
| Code-evaluated conditions inside procedures | ✓ | ? | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ | ✓ | ~ | — |
| Required-slot entry/exit gates | ~ | ? | ~ | ✓ | ✓ | ✓ | ? | ? | ? | ~ | ? | — |
| Knowledge sources with re-sync | ✓ | ~ | ✓ | ✓ | ✓ | ✓ | ? | ? | ? | ~ | ? | ✓ |
| Tools/actions with error branch | ✓ | ? | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ | ✓ | ? | ~ |
| Approval/confirm step before a write | ? | ? | ~ (webhook wait) | ✓ (EAP) | ~ | ? | ? | ✓ (code validations) | — | ? | ? | — |
| Draft → publish → version/restore | ✓ (workflows) | ? | ? | ✓ | ✓ | ✓ | ✓ | ✓ (git) | ? | ? | ? | ? |
| Simulated customers + pass/fail judge | — | — | ✓ | ~ | — | ✓ (LLM eval) | ✓ | ✓ | — | — | — | — |
| Scripted regression tests (assert tool called) | ? | ? | ~ (batch) | ✓ | ~ (emulator) | ✓ | ✓ | ✓ | — | — | — | — |
| Routing (round robin, online, load, language) | ✓ | ? | ? | ? | ~ | ? | ? | ? | ? | ✓ | ✓ | ? |
| Lifecycle / pipeline stages driving automations | ✓ | ? | — | — | — | — | — | — | ~ | ✓ | ~ | — |
| Operator copilot (draft, summary, translate) | ✓ | — | ✓ | ? | ~ (summary agent) | — | ? | ✓ | — | ✓ | ✓ | — |
| Ad / comment / story entry triggers | ✓ (ad context) | ? | — | — | — | — | — | — | ✓ | ~ | ? | — |
| Messaging-window enforcement in product | ? | ? | — | — | — | — | — | — | ✓ | ? | ? | — |
| Resolution metrics with explicit definitions | ~ | ~ (daily report) | ✓ | ✓ (tiers) | ~ | ✓ | ✓ (outcome pricing) | ✓ | — | ? | ✓ | ~ |
| A/B or traffic-split of agent versions | ? | — | ? | ✓ | — | ✓ (environments) | ? | ✓ | — | — | — | — |
| Local CIS payment/CRM integrations | — | ✓ (amoCRM, 1C, Payme, Click) | — | — | — | — | — | — | — | ✓ | — | — |

Sources by product (one line each; confidence in brackets):
- **respond.io**: [AI agent FAQ](https://respond.io/faqs/what-can-respondio-ai-agents-handle-and-how-are-they-trained), [workflows](https://respond.io/help/workflows/workflows-overview), [lifecycle action](https://respond.io/help/ai-agent-actions/ai-agent-action-update-lifecycle-stage), [AI assist](https://respond.io/help/workspace-settings/ai-assist). Templates are Receptionist, Sales and Support. Agents may only move contacts between **predefined** lifecycle stages, using written criteria. Workflows are drafted, then published. Telegram support is *unverified*. [medium]
- **reveo.uz**: [home](https://reveo.uz), [pricing](https://reveo.uz/pricing). Uzbek SMB focus, with an AI chat manager on Telegram, Instagram and WhatsApp. Integrations: amoCRM, 1C, SAP, Odoo, Billz, Payme, Click, Uzum. Priced in USD and paid in soums; setup is included. Its language handling (Latin/Cyrillic) and AI behaviour are *unverified*. [low-medium]
- **Intercom Fin**: [procedures](https://www.intercom.com/help/en/articles/13449439-building-fin-procedures), [simulations](https://www.intercom.com/help/en/articles/14077180-simulations-vs-batch-tests-vs-previews), [guidance](https://www.intercom.com/help/en/articles/13177409-customize-fin-ai-agent-tone-of-voice-and-answer-length), [resolutions](https://intercom.com/help/en/articles/8205718-fin-ai-agent-resolutions). Procedures are typed steps (instruction, condition, sub-procedure, handoff, end). Connector inputs are fixed by configuration, and a condition follows every connector call. Simulations run against mock connectors with outcome criteria. A resolution is confirmed or assumed, and a handoff never counts. Versioning is *unverified*. [medium-high]
- **Zendesk AI agents**: [generative procedures](https://support.zendesk.com/hc/en-us/articles/10040865503898-Managing-generative-procedures-for-AI-agents), [actions](https://support.zendesk.com/hc/en-us/articles/10783053154202-About-actions-in-AI-agents), [approval in action flows (EAP)](https://support.zendesk.com/hc/en-us/articles/11156518384922-Advanced-action-flows-API-reference-EAP), [A/B](https://support.zendesk.com/hc/en-us/articles/8357758896410-Performing-A-B-testing-for-AI-agents), [resolution tiers](https://support.zendesk.com/hc/en-us/articles/9570369117338-About-automated-resolution-tiers). Draft/publish with versions that can be restored as drafts. [medium]
- **Botpress**: [autonomous node](https://botpress.com/docs/studio/concepts/nodes/autonomous-node/), [variables](https://botpress.com/docs/studio/concepts/variables), [agents pipeline](https://botpress.com/docs/studio/concepts/agents/introduction), [versions](https://botpress.com/docs/studio/concepts/versions/), [v12 slot filling](https://v12.botpress.com/building-chatbots/flow-editor/skill-nodes/slot-filling). The LLM gets variable access only through a per-variable allow-list. Guardrails are prompt-level only. [medium]
- **Voiceflow**: [playbooks](https://www.voiceflow.com/docs/documentation/build/playbooks), [evaluations](https://www.voiceflow.com/docs/documentation/measure/evaluations), [environments](https://www.voiceflow.com/docs/courses/migrate-to-environments), [knowledge metadata](https://www.voiceflow.com/docs/courses/advanced-knowledge-base). Playbooks are goal-based, with entry/exit conditions on required variables. Deterministic workflows are used only where a fixed path is needed. Environments branch and support traffic splits. [medium]
- **Sierra**: [simulations](https://sierra.ai/blog/simulations-the-secret-behind-every-great-agent), [Agent SDK](https://sierra.ai/product/agent-sdk). Personas are simulated, run several times, and graded by an independent judge. Release is gated in CI, and each workflow has a setting between flexible and deterministic. Grounding and "supervisors" are *unverified*. [medium-low]
- **Decagon**: [AOP](https://decagon.ai/blog/why-we-built-aop), [product](https://decagon.ai/product/aop). Procedures are natural language, with critical checks written as code. Git versioning and simulations at scale. Watchtower QA is thin, *unverified*. [medium]
- **ManyChat**: secondary sources only ([getkanal](https://getkanal.com/blog/manychat-instagram), [socialpilot](https://www.socialpilot.co/strategy/instagram-comment-to-dm-automation)). Triggers fire on keyword comments, story replies and story mentions. One private reply goes out per comment, and the window opens only once the user answers. [medium-low]
- **Kommo/amoCRM**: [basics](https://support.kommo.com/docs/kommo-basics), [Salesbot](https://developers.kommo.com/reference/salesbot), [IT Park event](https://www.it-park.uz/index.php/en/itpark/news/amocrm-business-conference-in-uzbekistan). Stage changes trigger automations, every chat is linked to a lead, and a unified inbox includes Telegram. It has a Tashkent presence, but its market share is *unverified*. [medium]
- **Wati**: [overview](https://support.wati.io/en/articles/11375155-wati-overview-features-channels-and-integrations). Shared WhatsApp inbox with templates, broadcasts, an AI agent and an inbox copilot. [medium]
- **Tidio Lyro**: [pricing](https://www.tidio.com/pricing). Answers come only from knowledge, with pay-per-resolution options. Its handoff triggers are *unverified*. [medium]
- **CIS/Uzbek others**: [Bitrix24 CoPilot](https://helpdesk.bitrix24.com/open/25855535/), [Aimylogic in Bitrix24](https://help.cloud.just-ai.com/en/aimylogic/publication_channels/bitrix24), [Salebot](https://docs.salebot.pro/), [Umnico × Uzum (vendor claim)](https://umnico.com/blog/user-case-uzum-eng/). Researchers found **no dedicated Uzbek-language AI sales agent** other than reveo; the evidence is thin. [low-medium]

## The 10 highest-value patterns for AgentCore
1. **Typed playbooks.** Named steps (ask/collect, condition, tool call with mandatory error/empty branch, sub-playbook, handover, end). Conditions are evaluated by code, and the LLM only extracts and phrases. Source: Fin, Zendesk, Voiceflow, Decagon.
2. **Required-slot entry/exit gates per playbook.** A playbook cannot finish until code confirms its slots. The LLM gets read/write access only to the variables a playbook allows. Source: Voiceflow, Botpress.
3. **Agent profile as versioned config.** Template (Sales / Support / Receptionist) plus name, role, tone, guidance rules and an allow-list of tools/actions. Moves draft → publish → rollback, with version notes. Source: respond.io, Zendesk, Voiceflow.
4. **Simulation gate.** Persona-driven simulated customers against mock connectors, with outcome-based pass/fail criteria and an independent judge. Runs several times per scenario and blocks publish/CI. Source: Sierra, Fin, Voiceflow, Decagon.
5. **Predefined lifecycle stages with criteria.** The agent may only move a lead between stages the tenant defined, with a reason. Stage changes trigger deterministic automations (follow-up, assign, notify). Source: respond.io, Kommo.
6. **Explicit resolution taxonomy.** Confirmed, assumed and escalated, where a handover never counts as resolved. Recovered leads and cost per resolution are computed from these. Source: Fin, Zendesk.
7. **Routing templates.** Online-only, round robin, least-open, by language, by skill, by shift, with VIP/returning-customer rules, so handover lands on an available person who reads the language. Source: respond.io, Kommo.
8. **Entry-point context.** Ad referral, comment keyword, story reply and deep-link payload are captured as a typed `EntryContext` on the conversation and lead, and can select a playbook. Source: ManyChat, respond.io, Meta and Telegram docs.
9. **Operator copilot.** Draft reply with sources (human approves), closing summary, translation. Source: Fin, respond.io, Kommo, Wati.
10. **Per-turn trace.** Model calls, tool calls, guardrail results and the chosen playbook step, visible to operators and in debugging. Also feeds A/B comparison of agent versions. Source: Sierra, Decagon, Zendesk.

## What we deliberately skip
- **Visual drag-and-drop flow builder.** Both builder vendors are moving to instructions plus tools, and a canvas fights D3/D4. Build declarative, validated playbook config edited in a form, with a read-only graph view at most.
- **Natural-language-only procedures or AI-generated flow maps.** Code must decide slots, conditions and writes (D4/D5).
- **Prompt-only guardrails.** We keep typed provenance and code checks.
- **Time-based "assumed resolution" as the headline metric.** It inflates success; report it only next to explicit signals.
- **Broadcasts, mass promos, paid Telegram broadcast.** Policy risk and out of v1 scope.
- **Call recording, wearable offline analytics, voice.** Voice/STT is deferred by owner decision.
- **In-bot tables as a data store.** Facts come from the CRM through tools (D1).
- **Credit-metered AI billing and plan-limited version slots.**
