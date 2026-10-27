# ADR 011: Token-efficient specification layout and model policy

- **Status:** Accepted
- **Date:** 2026-10-23

## Context
`AGENTS.md` (432 lines) was loaded into every session and told agents to re-read it whole. Most sessions need a fraction of it. Separately, work should use the cheapest adequate model and never exceed Opus 5.5.

## Decision
**Layout.** The original text is split by numbered section into `docs/spec/01…12` (index: `docs/spec/README.md`); section numbers, D1–D22 and phase names are unchanged, so ADR/PROGRESS references stay valid. Root `AGENTS.md` is a ~80-line index: product, non-negotiable rules, one-line D1–D22, and a read-on-demand table using backticked paths (not `@imports`, which load eagerly). Path-scoped invariants live in `.claude/rules/*.md` with `paths:` frontmatter. `docs/PROGRESS.md` is a short current-state block; history moved to `docs/progress-archive.md`. The addendum file is absent from the repo; `docs/spec/00-addendum.md` says so and points to ADR 002.

**Intentional wording changes** (all other lines are verbatim in `docs/spec/`): the rule "read this entire file at the start of every session" (§0.1) is replaced in `AGENTS.md` by "read the index, the current phase, and relevant files only"; §16 step 1 ("summarize in 20 lines") is not required each session; the spec file text itself still contains the original wording.

**Model policy.** Ceiling Opus 5.5; never fable/best/Mythos. Project default `sonnet`. Four subagents (`mechanical` haiku, `builder` sonnet, `architect` opus read-only ≤1 call per stage, `reviewer` sonnet read-only). Builder failing a step twice escalates to architect once, then stops. Managed-settings enforcement is documented in `docs/CLAUDE_CODE_SETUP.md` for the owner to apply.

**Instructions file.** `AGENTS.md` is the canonical file and `CLAUDE.md` only imports it; see the Amendment (2026-10-26) at the end of this ADR.

## Consequences
Smaller default context; the full spec remains available on demand. Rules in `.claude/rules/` duplicate a few invariants deliberately (short, with pointers). Subagent model aliases follow the docs of 2026-10-23.

## Amendment (2026-10-26): one instructions file
`AGENTS.md` is the single canonical source of the project instructions. The root `CLAUDE.md` contains exactly `@AGENTS.md` (Claude Code's import syntax) and nothing else, so Claude Code and other tools read the same text and the two cannot drift. `apps/api/src/config/claude-config.spec.ts` enforces it: `AGENTS.md` must exist and the normalized content of `CLAUDE.md` must equal `@AGENTS.md`. The earlier wording in `docs/spec/01-vision-context.md` ("`CLAUDE.md` or `AGENTS.md`") is corrected. Recorded here instead of a new ADR number because this decision only concerns the file layout this ADR introduced.
