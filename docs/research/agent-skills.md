# Agent skills relevant to AgentCore (search 2026-10-26)

Found with `npx skills find <query>` (the skills.sh registry) on 2026-10-26. Install counts are the registry's own figures from that search. Source repository stars and skill contents were **not checked**, and **nothing was installed**. Skills are third-party instructions and scripts: read a skill's files before installing it, and install only what the owner approves.

Install one skill: `npx skills add <owner/repo@skill>`. Add `-g` for user-level, `-y` to skip prompts. The `superpowers` plugin could not be installed through `/plugin` in this environment, but its skills are installable one by one through `npx skills add obra/superpowers@<skill>`.

Already available without installing anything: built-in `/code-review` and `/security-review`, plus the project subagents `reviewer`, `builder`, `architect` and `mechanical` (AGENTS.md).

## Shortlist by project need
| Need in this repo | Skill | Installs | Why | Note |
|---|---|---|---|---|
| DEF-007 (adapter timestamps), Prisma 7 with driver adapters | `prisma/skills@prisma-driver-adapter-implementation` | 376.8K | From the official Prisma org; covers driver-adapter behavior | Most relevant to the current fix |
| Prisma queries, CLI and migrations | `prisma/skills@prisma-client-api`, `prisma/skills@prisma-cli` | 391.3K, 388.6K | Official Prisma org | — |
| PostgreSQL practice | `supabase/agent-skills@supabase-postgres-best-practices` | 460.6K | General Postgres guidance | Supabase-flavoured; ignore the hosting parts |
| Bug diagnosis (failure taxonomy, root cause before fix) | `mattpocock/skills@diagnosing-bugs`, `obra/superpowers@systematic-debugging` | 841.6K, 308.1K | Fits the evidence-first rule (AGENTS.md 6) | — |
| Code review workflow | `mattpocock/skills@code-review`, `obra/superpowers@requesting-code-review`, `obra/superpowers@receiving-code-review` | 796.5K, 263.4K, 222.7K | Review and response discipline | Overlaps the built-in `/code-review` |
| NestJS structure | `kadajett/agent-nestjs-skills@nestjs-best-practices` | 30.5K | NestJS conventions | Community source |
| Vitest | `antfu/skills@vitest` | 43.7K | Vitest usage | Community source (well-known author) |
| LLM evaluation, judge calibration (ADR 026: ≥ 20 conversations per language) | `refoundai/lenny-skills@ai-evals`, `arize-ai/phoenix@phoenix-evals`, `hamelsmu/evals-skills@write-judge-prompt` | 2.1K, 1.6K, 797 | Eval design and judge prompts | Low install counts (`write-judge-prompt` < 1K): review the content before use |
| Telegram | `claude-office-skills/skills@telegram-bot` | 6.2K | Generic bot building | Low value: the repo has its own adapter, queue and webhook rules |
| Security | — | — | Searching "security" returned only Azure-specific skills | Use the built-in `/security-review` |

## Queries run
`code review`, `postgres`, `prisma`, `nestjs`, `llm evals`, `vitest`, `telegram`, `security`, `systematic debugging`.
