import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PROVIDER_PRESETS } from '../src/llm/provider-presets.js';
import { mergeStatus, renderStatus, smokeProvider } from '../src/llm/smoke.js';

/**
 * pnpm llm:smoke [provider ...]
 * Keys come from the env vars named by each preset (.env.local, then .env at
 * the repository root, then the shell). Nothing secret is printed. For
 * providers without a default model set SMOKE_MODEL_<PRESET_ID_UPPERCASE>.
 * Updates docs/LLM_PROVIDER_STATUS.md: only the tested providers' rows change;
 * other rows and the observations section are kept.
 */
const root = resolve(process.cwd(), '../..');
loadEnv({ path: resolve(root, '.env.local'), quiet: true });
loadEnv({ path: resolve(root, '.env'), quiet: true });

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const results = [];
  for (const preset of PROVIDER_PRESETS.values()) {
    if (wanted.length > 0 && !wanted.includes(preset.id)) continue;
    const apiKey = process.env[preset.apiKeyEnvVar] || undefined;
    if (preset.apiKeyRequired && !apiKey) {
      results.push({
        provider: preset.id,
        skipped: `${preset.apiKeyEnvVar} not set`,
      });
      continue;
    }
    const model =
      process.env[`SMOKE_MODEL_${preset.id.toUpperCase()}`] ??
      preset.defaultModels.FAST;
    if (!model) {
      results.push({
        provider: preset.id,
        skipped: `no default model; set SMOKE_MODEL_${preset.id.toUpperCase()}`,
      });
      continue;
    }
    const result = await smokeProvider({ preset, model, apiKey });
    results.push(result);
    process.stdout.write(
      `${result.provider} ${result.model} chat=${result.chat} tools=${result.tools} json_schema=${result.jsonSchema} ${result.latencyMs}ms tokens=${result.inputTokens}/${result.outputTokens}\n`,
    );
  }
  for (const r of results)
    if ('skipped' in r)
      process.stdout.write(`${r.provider} skipped: ${r.skipped}\n`);
  const date = new Date().toISOString().slice(0, 10);
  const file = resolve(root, 'docs/LLM_PROVIDER_STATUS.md');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  writeFileSync(file, mergeStatus(existing, renderStatus(results, date), date));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.name : 'smoke failed'}\n`,
  );
  process.exitCode = 1;
});
