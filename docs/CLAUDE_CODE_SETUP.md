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
- Start each session from `AGENTS.md` + the top of `docs/PROGRESS.md`; read spec files on demand (`docs/spec/README.md`).
- Path-scoped rules in `.claude/rules/` load only when matching files are touched.
- Use Sonnet for building, Opus only for design/hard debugging (via the `architect` subagent), Haiku for mechanical work.
- Cap command output (`| tail -n 60`); avoid pasting logs; at ~60% context run `/clear` after updating PROGRESS.

## Enforcing the ceiling (managed settings, for you to apply)
`availableModels`, `deniedModels` and `enforceAvailableModels` are honored only in managed settings (`deniedModels` is ignored with a warning elsewhere; it needs Claude Code v2.1.283+). This repository does not write system paths. Example to apply with your administrator or OS-level managed-settings location (see the Model configuration page for the file path):

```json
{
  "availableModels": ["haiku", "sonnet", "opus"],
  "deniedModels": ["fable", "best"],
  "enforceAvailableModels": true
}
```
The docs' own example denies by full ID (`"deniedModels": ["claude-opus-5-5"]`); whether aliases and Fable IDs are matched by `deniedModels` entries `fable`/`best` should be checked against the page when applying — unverified here.
