import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Scenario } from './scenario.js';

/** A recorded, hashed selection of scenario x language units (amendment 5). */
const SubsetSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/u),
    description: z.string().min(10),
    units: z
      .array(z.string().regex(/^[a-z]+-\d{2}\/(uz-Latn|uz-Cyrl|ru|en)$/u))
      .min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
export type Subset = z.infer<typeof SubsetSchema>;

export const unitId = (scenarioId: string, language: string): string =>
  `${scenarioId}/${language}`;

export function subsetHash(units: readonly string[]): string {
  return createHash('sha256')
    .update([...units].sort().join('\n'))
    .digest('hex');
}

/** Every runnable unit of the suite (retail has no v1 pack and is excluded). */
export function fullUnits(scenarios: readonly Scenario[]): string[] {
  return scenarios
    .filter((s) => s.pack !== 'retail')
    .flatMap((s) => s.languages.map((language) => unitId(s.id, language)));
}

/**
 * Loads a subset and checks it: the recorded hash matches its units, and
 * every unit exists in the scenario suite.
 */
export function loadSubset(
  root: string,
  name: string,
  scenarios: readonly Scenario[],
): Subset {
  const subset = SubsetSchema.parse(
    JSON.parse(readFileSync(join(root, 'subsets', `${name}.json`), 'utf8')),
  );
  if (subsetHash(subset.units) !== subset.sha256)
    throw new Error(`subset ${name}: recorded sha256 does not match its units`);
  const known = new Set(fullUnits(scenarios));
  const missing = subset.units.filter((u) => !known.has(u));
  if (missing.length)
    throw new Error(`subset ${name}: unknown units ${missing.join(', ')}`);
  return subset;
}
