# 02 — Rollback a release

When: a deploy broke the app and a fix cannot ship in minutes. Safe because migrations are additive: the previous image runs on the newer schema (a column the old code does not know is ignored).

## Before you start
- Find the previous good tag: the short commit id of the last successful `deploy-staging` run before the bad one (GitHub, Actions, `CI` on `feat/production-pilot`), or on the host `docker images --format '{{.Repository}}:{{.Tag}}' | grep tezda-` (the host keeps the current and the previous tag; older ones can be pulled again from `ghcr.io`).
- Do NOT roll back by force-pushing the branch: history is never rewritten. A rollback is "run the old images", and the fix is a normal new commit.
- If the release included a migration, the old code still works with it. If a release ever includes a destructive migration (it must not), restore from backup instead (06).

## Steps (run on the host through SSM)
1. `cd /opt/tezda/deploy`
2. `sed -n 's/^TAG=//p' .env.production` shows the running tag; write it down.
3. `sed -i "s/^TAG=.*/TAG=<previous tag>/" .env.production`
4. `dc pull --quiet && dc up -d --wait` (use the `dc` function from the README here; do not run the migrate step: the schema stays as it is).
5. Check from outside: `/login` 200, `/api/v1/auth/me` 401; then log in, open Inbox and Leads, send a test message to the Telegram test bot.

## After
- The next push to `feat/production-pilot` deploys the newest tag again, so say so in the team channel: do not push the same defect again.
- Open the fix on a branch, run the full CI there, and release it the normal way.
- If the bad tag was not pulled before, its images may have been pruned: this is fine, they are rebuilt by CI.

## Known limits
- Not rehearsed. First rehearsal: roll back one release on staging and forward again; record the time here.
- A data change made by the bad release (for example rows written in a new format) is not undone by a rollback: check it by hand and use 06 if needed.
