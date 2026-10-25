#!/usr/bin/env node
// Universality gate (Phase 7.1, ADR 024): a commit that onboards a domain
// carries the trailer `Pack-Onboarding: <pack>` and must not change the
// universal core. Checks every such commit in BASE..HEAD (default origin/main).
import { execFileSync } from 'node:child_process';

const base = process.argv[2] ?? process.env.ONBOARDING_BASE ?? 'origin/main';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const range = `${base}..HEAD`;
const commits = git('log', '--format=%H', '--grep=^Pack-Onboarding:', range).split('\n').filter(Boolean);
let failed = false;
for (const sha of commits) {
  const changed = git('show', '--name-only', '--format=', sha).split('\n').filter(Boolean);
  const core = changed.filter((path) => path.startsWith('apps/api/src/core/'));
  const pack = git('log', '-1', '--format=%(trailers:key=Pack-Onboarding,valueonly)', sha);
  if (core.length > 0) {
    failed = true;
    console.error(`FAIL ${sha.slice(0, 7)} (${pack}): onboarding changed the core:\n  ${core.join('\n  ')}`);
  } else {
    console.log(`ok   ${sha.slice(0, 7)} (${pack}): ${changed.length} files, none in apps/api/src/core`);
  }
}
if (commits.length === 0) console.log(`no Pack-Onboarding commits in ${range}`);
process.exit(failed ? 1 : 0);
