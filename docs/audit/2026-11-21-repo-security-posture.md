# Repository security posture (P0.1), checked 2026-11-21

Read through the GitHub API with the owner's `gh` login; nothing was changed.

## Found
| Item | State |
|---|---|
| Visibility | public |
| Branches | 97, none protected (`GET /branches`) |
| `main` (default), `feat/production-pilot` (staging deploys on push) | "Branch not protected" |
| Rulesets | none (`[]`) |
| Dependabot alerts / security updates | disabled |
| Secret scanning, push protection, validity checks | disabled |
| Code scanning | no analysis ever uploaded; no CodeQL workflow in `.github/` |
| `.github/dependabot.yml` | absent |
| CI (`.github/workflows/ci.yml`) | runs on every push and pull request; `deploy-staging` only on a push to `feat/production-pilot` |
| `main` vs working branch | `feat/ui-words-menu` is 752 commits ahead of `origin/main` and 95 behind (diverged); staging is built from `feat/production-pilot`, not `main` |

Check-run names on a commit (exact strings a required check must use): `quality`, `e2e (shard 1/4)`, `e2e (shard 2/4)`, `e2e (shard 3/4)`, `e2e (shard 4/4)`, `security`, `images`. `publish` and `deploy-staging` run only on the staging branch and must not be required (they are skipped elsewhere).

## Recommended (owner, GitHub UI: Settings)
1. **Code security** (free for public repositories): turn on Secret scanning and Push protection; Dependabot alerts and Dependabot security updates; Code scanning default setup (CodeQL, JavaScript/TypeScript and Actions).
2. **Ruleset `protect-main`** on `main`: block deletion and force pushes; require a pull request (one approval may be skipped while there is one maintainer); require the status checks listed above, up to date with the base branch.
3. **Ruleset `protect-staging`** on `feat/production-pilot`: block deletion and force pushes; require the same status checks. No pull request rule: staging is released by fast-forwarding to a commit whose checks already passed on the working branch (checks belong to the commit SHA, so a fast-forward to a green SHA satisfies them).
4. Optional: a `.github/dependabot.yml` for npm (weekly, grouped) and GitHub Actions, so updates arrive as pull requests that run CI.

## Not checked
Organisation-level settings, Actions permissions and environments, and who holds admin access.
