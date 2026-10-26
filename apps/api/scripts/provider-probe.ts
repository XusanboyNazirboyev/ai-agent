/**
 * Smoke checks for lanes that may not run yet (amendment 7): synthetic prompts
 * only, at most 5 HTTP requests per provider per day (local budget file), no
 * retries, keys never printed, only status / classification / redacted codes.
 *
 *   SIM=1 pnpm provider:probe gemini openrouter mistral
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import {
  classifyResponse,
  LaneTraffic,
} from '../src/agent/testing/simulation/provider-traffic.js';
import { OpenAiCompatibleLlmProvider } from '../src/llm/openai-compatible/openai-compatible-provider.js';
import { presetFor } from '../src/llm/provider-presets.js';

const root = resolve(process.cwd(), '../..');
loadEnv({ path: resolve(root, '.env'), quiet: true });
const MAX_PER_DAY = 5;
const budgetFile = resolve(root, 'eval/reports/probe-budget.json');
const today = new Date().toISOString().slice(0, 10);

function takeBudget(provider: string): void {
  const all = existsSync(budgetFile)
    ? (JSON.parse(readFileSync(budgetFile, 'utf8')) as Record<
        string,
        Record<string, number>
      >)
    : {};
  const used = all[today]?.[provider] ?? 0;
  if (used >= MAX_PER_DAY)
    throw new Error(`${provider}: daily probe budget (${MAX_PER_DAY}) used`);
  all[today] = { ...all[today], [provider]: used + 1 };
  mkdirSync(dirname(budgetFile), { recursive: true });
  writeFileSync(budgetFile, `${JSON.stringify(all, null, 2)}\n`);
}

function counted(provider: string): typeof fetch {
  return (input, init) => {
    takeBudget(provider);
    return fetch(input, init);
  };
}

async function openRouterModel(apiKey: string): Promise<string | undefined> {
  const f = counted('openrouter');
  const key = await f('https://openrouter.ai/api/v1/key', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const keyBody = (await key.json().catch(() => ({}))) as {
    data?: {
      free_model_daily_requests?: {
        used?: number;
        limit?: number;
        remaining?: number;
      };
    };
  };
  const free = keyBody.data?.free_model_daily_requests;
  process.stdout.write(
    `openrouter /key: HTTP ${key.status}; free model daily requests used ${free?.used ?? '?'} / limit ${free?.limit ?? '?'} / remaining ${free?.remaining ?? '?'}\n`,
  );
  const list = await f('https://openrouter.ai/api/v1/models', {});
  const models =
    (
      (await list.json().catch(() => ({}))) as {
        data?: { id: string; supported_parameters?: string[] }[];
      }
    ).data ?? [];
  const candidates = models
    .filter((m) => m.id.endsWith(':free'))
    .filter((m) =>
      ['tools', 'structured_outputs'].every((p) =>
        m.supported_parameters?.includes(p),
      ),
    )
    .map((m) => m.id)
    .sort();
  process.stdout.write(
    `openrouter /models: HTTP ${list.status}; :free models advertising tools + structured_outputs: ${candidates.length} (first: ${candidates.slice(0, 3).join(', ') || 'none'})\n`,
  );
  return candidates[0];
}

async function probe(id: string): Promise<void> {
  const preset = presetFor(id);
  const apiKey = preset.apiKeyEnvVar
    ? process.env[preset.apiKeyEnvVar]
    : undefined;
  if (preset.apiKeyRequired && !apiKey) {
    process.stdout.write(`${id}: ${preset.apiKeyEnvVar} MISSING; not probed\n`);
    return;
  }
  const model =
    id === 'openrouter'
      ? await openRouterModel(apiKey!)
      : preset.defaultModels?.FAST;
  if (!model) {
    process.stdout.write(`${id}: no model to probe\n`);
    return;
  }
  const traffic = new LaneTraffic({
    provider: id,
    fetchImpl: counted(id),
    maxRetries: 0,
    sleep: (): Promise<void> => Promise.resolve(),
  });
  const provider = new OpenAiCompatibleLlmProvider({
    baseUrl: preset.baseUrl,
    apiKey,
    models: { FAST: model, STRONG: model },
    structuredOutput: 'json_schema',
    maxTokensParam: preset.maxTokensParam,
    requestTimeoutMs: 30_000,
    maxRetries: 0,
    fetch: traffic.fetch,
  });
  const base = {
    tier: 'FAST' as const,
    purpose: 'evaluate' as const,
    system: 'You are a test endpoint. Fictional data only.',
    maxOutputTokens: 200,
  };
  const steps: [string, () => Promise<unknown>][] = [
    [
      'chat',
      (): Promise<unknown> =>
        provider.generateWithTools({
          ...base,
          messages: [{ role: 'user', text: 'Reply with the word: ok' }],
          tools: [],
        }),
    ],
    [
      'tool call',
      (): Promise<unknown> =>
        provider.generateWithTools({
          ...base,
          messages: [
            {
              role: 'user',
              text: 'What time is it in the test city? Use the tool.',
            },
          ],
          tools: [
            {
              name: 'get_time',
              description: 'Returns the time in a city',
              inputSchema: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          ] as never,
        }),
    ],
    [
      'json_schema',
      (): Promise<unknown> =>
        provider.generateStructured({
          ...base,
          messages: [{ role: 'user', text: 'Return {"answer":"ok"}' }],
          schemaName: 'probe',
          jsonSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['answer'],
            properties: { answer: { type: 'string' } },
          },
          schema: z.object({ answer: z.string() }),
        }),
    ],
  ];
  for (const [name, call] of steps) {
    const started = Date.now();
    let outcome = 'ok';
    try {
      await call();
    } catch (error) {
      outcome =
        error instanceof Error
          ? `${error.name}${'code' in error ? `:${String((error as { code: unknown }).code)}` : ''}`
          : 'error';
    }
    const last = traffic.takeEvents().at(-1);
    process.stdout.write(
      `${id} ${model} ${name}: ${outcome}; traffic ${last?.kind ?? 'none'}${last?.status ? ` HTTP ${last.status}` : ''}${last?.window ? ` window ${last.window}` : ''}${last?.code ? ` code ${last.code}` : ''}; ${Date.now() - started} ms\n`,
    );
    if (traffic.exhausted || (last && last.kind !== 'ok')) {
      process.stdout.write(
        `${id}: stopping after a non-ok response (budget kept)\n`,
      );
      break;
    }
  }
}

async function main(): Promise<void> {
  if (process.env.SIM !== '1') throw new Error('Probes are opt-in: set SIM=1.');
  const wanted = process.argv.slice(2);
  for (const id of wanted) {
    if (!['gemini', 'openrouter', 'mistral'].includes(id))
      throw new Error(`${id}: probes are for gemini, openrouter, mistral`);
    try {
      await probe(id);
    } catch (error) {
      process.stdout.write(
        `${id}: ${error instanceof Error ? error.message : 'probe failed'}\n`,
      );
    }
  }
}

// Exported for reuse in tests of the classification of probe responses.
export { classifyResponse };

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'probe failed'}\n`,
  );
  process.exitCode = 1;
});
