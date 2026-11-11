# Prompt to paste into Kilo to continue

You are continuing work on **AgentCore / "tezda"**, a multi-tenant AI sales and support agent (NestJS + Prisma/PostgreSQL + BullMQ, Next.js web) deployed to a single AWS staging host. The previous agent session ended mid-project; you have no memory of it.

**Before doing anything, read in this order** (do not read any `.jsonl` transcript): `docs/HANDOFF_2026-11-11.md` (state, staging access, rules, next steps), `AGENTS.md`, the top of `docs/PROGRESS.md`, `docs/audit/2026-11-10/AGENTCORE_EXECUTIVE_SUMMARY.md` and `AGENTCORE_DEVELOPMENT_ROADMAP.md`. Verify the handoff against the repository (`git fetch`, branch heads, CI) because it is a snapshot.

**Language:** the owner writes Uzbek (Latin). Reply to the owner in Uzbek; write code, commits and documentation in English.

**Working rules (hard):**
1. Work only in a **new git worktree** created from `origin/feat/production-pilot` (`git worktree add -b <branch> <path> origin/feat/production-pilot`). Never touch the owner's main working directory: it is on another branch with 60 uncommitted changes from other agents.
2. Never push to `feat/production-pilot` (that deploys staging; the owner does it), never touch `main`, never force-push, reset or delete branches. Feature branches may be pushed.
3. Ask the owner first for: AWS changes (IAM, S3, Parameter Store), writes on the staging host, deleting data, dependency or toolchain changes, anything outward-facing.
4. Never print or commit secrets; read env var names only. Hard business facts come only from tools, rendered by code. Tenant isolation everywhere (`tenantId` on tenant rows); platform code stays separate from tenant code.
5. Tests with every change, additive migrations only, an ADR for significant decisions, update `docs/PROGRESS.md`. Run the gates listed in the handoff (section 7); report honestly what ran and what did not.
6. Use small commits. Split large work into steps; do not try to finish a big feature in one pass.

**Start with:**
1. Check that the staging deploy of `feat/production-pilot` (head `d34e35a` at handoff) finished and is healthy (handoff section 5). If you have no AWS access, ask the owner to run `aws login` (profile `tezda`).
2. Tell the owner to enrol MFA at `/console/login` and to resend an Instagram voice message after "return to bot".
3. Then continue the roadmap: **P0.6** (data retention and deletion), then **P0.7** (Postgres RLS), then **P1** (CRM spine), as described in the handoff, section 6. Before each step, state the plan in a few lines and wait for the owner's go-ahead if it touches staging or AWS.

Finish each reply with what is done, what is verified, what is not, and what you need from the owner.
