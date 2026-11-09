/**
 * Live failover check of the `builtin:gemini-primary` routing policy
 * (owner decision 2026-11-09): the paid Gemini answers first, then Groq,
 * Mistral and OpenRouter. Each scenario replaces the keys of the providers
 * in front with an invalid placeholder, so the request must fall through to
 * the next one. Synthetic text only; a few cheap calls.
 *
 *   pnpm exec tsx --env-file=<path to .env> scripts/llm-failover-live.ts
 *
 * Env: GEMINI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, OPEN_ROUTER_API_KEY
 * (values never printed).
 */
import { performance } from 'node:perf_hooks';
import type { ToolGenerationRequest } from '../src/core/llm/llm-provider.js';
import { PRICING_CATALOG } from '../src/llm/pricing-catalog.js';
import {
  buildRoutedProvider,
  loadRoutingPolicy,
} from '../src/llm/routing/routing-factory.js';

const KEYS = [
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPEN_ROUTER_API_KEY',
] as const;
const EXPECTED = ['gemini', 'groq', 'mistral', 'openrouter'];

const REQUEST: ToolGenerationRequest = {
  tier: 'FAST',
  purpose: 'respond',
  system:
    'Siz o‘quv markazi operatorisiz. Faqat o‘zbek tilida (lotin), bitta qisqa gap bilan javob bering. Kurs haqida so‘ralsa search_catalog chaqiring.',
  messages: [
    { role: 'user', text: 'Assalomu alaykum, qanday yordam bera olasiz?' },
  ],
  maxOutputTokens: 300,
  tools: [
    {
      name: 'search_catalog',
      description: 'Kurslarni qidiradi.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
};

async function main(): Promise<void> {
  const policy = loadRoutingPolicy('builtin:gemini-primary');
  const snapshot = PRICING_CATALOG.snapshot('routing-gemini-paid-2026-11-09');
  let failures = 0;
  for (let broken = 0; broken < KEYS.length; broken++) {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of KEYS.slice(0, broken))
      env[key] = 'invalid-placeholder-for-failover-test';
    const { provider, skipped } = buildRoutedProvider({
      policy,
      snapshot,
      env,
      trustedProviders: ['routed', ...EXPECTED],
      requestTimeoutMs: 20_000,
      maxRetries: 0,
      onFailover: (event) =>
        console.log(`     failover from ${event.from}: ${event.code}`),
    });
    if (skipped.length > 0)
      console.log(
        `  skipped: ${skipped.map((s) => `${s.candidate} (${s.reason})`).join(', ')}`,
      );
    const started = performance.now();
    try {
      const result = await provider.generateWithTools(REQUEST);
      const ok = result.providerId.includes(EXPECTED[broken]!);
      if (!ok) failures += 1;
      console.log(
        `${ok ? 'ok  ' : 'FAIL'} ${broken} broken -> ${result.providerId} ${result.model}, attempts ${result.attempts}, ${(performance.now() - started).toFixed(0)} ms: ${result.text.replace(/\s+/gu, ' ').slice(0, 90) || `[tool ${result.toolCalls[0]?.name ?? '-'}]`}`,
      );
    } catch (error: unknown) {
      failures += 1;
      const code = (error as { code?: string }).code ?? 'unknown';
      console.log(`FAIL ${broken} broken -> error ${code}`);
    }
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? `${error.name}: ${error.message}` : 'failed',
  );
  process.exitCode = 1;
});
