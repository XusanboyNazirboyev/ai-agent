#!/usr/bin/env node
// Prints the Phase 7.2 evaluation metrics written by `pnpm test:eval` and
// fails if a blocking gate is not met (independent re-check of the reports).
import { readFileSync } from 'node:fs';

const read = (name) => JSON.parse(readFileSync(new URL(`../eval/reports/${name}`, import.meta.url), 'utf8'));
const coverage = read('coverage.json');
const scripted = read('scripted-summary.json');
const lifecycle = read('lifecycle-summary.json');
const falseClaims = scripted.falseSuccessClaims + lifecycle.falseSuccessClaims;
console.log(`scripted:  ${scripted.passed}/${scripted.total} passed, invented facts ${scripted.hardFactViolations}, false success claims ${scripted.falseSuccessClaims}`);
console.log(`lifecycle: ${lifecycle.passed}/${lifecycle.cases} passed, false success claims ${lifecycle.falseSuccessClaims}, CRM write calls ${lifecycle.crmCalls}`);
console.log(`coverage:  ${JSON.stringify(coverage.perPack)}; per pack/locale ${JSON.stringify(coverage.totals)}`);
const failures = [
  ...(scripted.passed !== scripted.total ? ['scripted cases failed'] : []),
  ...(lifecycle.passed !== lifecycle.cases ? ['lifecycle cases failed'] : []),
  ...(falseClaims !== 0 ? [`false success claims = ${falseClaims} (must be 0)`] : []),
  ...(scripted.hardFactViolations !== 0 ? ['invented facts present'] : []),
  ...coverage.gaps.map((gap) => `coverage gap: ${gap}`),
];
if (failures.length > 0) {
  console.error(`EVAL GATE FAILED:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('EVAL GATE PASSED');
