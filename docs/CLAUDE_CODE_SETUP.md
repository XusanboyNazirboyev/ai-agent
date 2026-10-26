# Claude Code setup for this repository

Sources (read 2026-10-23): [Commands](https://code.claude.com/docs/en/commands), [Model configuration](https://code.claude.com/docs/en/model-config), [Memory and rules](https://code.claude.com/docs/en/memory), [Subagents](https://code.claude.com/docs/en/sub-agents).

## Model policy
- Ceiling: Opus 5.5. Never use or pin `fable`, `best` (which resolves to Fable where available) or any Mythos model.
- Project default (`.claude/settings.json`): `"model": "sonnet"`.
- The main model is changed only by you: `/model` or the model picker in the VS Code extension. Claude cannot change it.
- Subagents pin their own model (`.claude/agents/`): `mechanical` haiku, `builder` sonnet, `architect` opus (read-only), `reviewer` sonnet (read-only). Do not set `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`.

## Daily commands
| Command | Use |
|---|---|
| `/model [model]` | switch the main model (saves it as your default) |
| `/plan [task]` | enter plan mode before a risky change |
| `/usage` | session cost and plan limits |
| `/context` | see what fills the context window |
| `/compact [focus]` | summarize to free context, same conversation |
| `/clear` | new conversation; continue from `docs/PROGRESS.md` |

## Cost habits
- Start each session from `CLAUDE.md` + the top of `docs/PROGRESS.md`; read spec files on demand (`docs/spec/README.md`).
- Path-scoped rules in `.claude/rules/` load only when matching files are touched.
- Use Sonnet for building, Opus only for design/hard debugging (via the `architect` subagent), Haiku for mechanical work.
- Cap command output (`| tail -n 60`); avoid pasting logs; at ~60% context run `/clear` after updating PROGRESS.

## Enforcing the ceiling (managed settings, for you to apply)
Verified against the [Model configuration](https://code.claude.com/docs/en/model-config) page on 2026-10-23:
- `availableModels`, `enforceAvailableModels` and `deniedModels` are read from **managed settings only**; set elsewhere (user, project, local, `--settings`) they are ignored with a warning. This repository therefore cannot enforce the ceiling for a user's session and does not write system paths.
- `availableModels` entries are a family (`haiku`, `sonnet`, `opus`, `fable`), a version prefix (`claude-opus-5`) or a full ID; there is no glob syntax. `best` is not documented as an allowlist entry, so it is not listed. A model outside the allowlist cannot be selected, which is the documented way to exclude Fable: list only the allowed families.
- `enforceAvailableModels: true` (v2.1.175+) extends the allowlist to the Default option. `deniedModels` needs v2.1.283+; the page documents it with full IDs (`claude-opus-5-5`) and does not state whether family aliases are accepted there, so denial by `fable`/`best` is **unverified**; prefer the allowlist, and deny by full ID if you also want a denylist. Older versions ignore both keys; set `requiredMinimumVersion` too.

Minimal managed settings to apply (allowlist only; no unverified identifiers):
```json
{
  "availableModels": ["haiku", "sonnet", "opus"],
  "enforceAvailableModels": true,
  "requiredMinimumVersion": "2.1.283"
}
```
What the repository does check itself: `apps/api/src/config/claude-config.spec.ts` verifies that `.claude/settings.json` and every subagent use only `haiku`/`sonnet`/`opus`, that subagent frontmatter is complete, that read-only agents have no write tools, and that rule paths exist. It does not and cannot prove what a developer's machine allows.
