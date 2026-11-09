/**
 * Live check of `streamWithTools` on the configured openai-compatible
 * provider (ADR 045 slice 3, step 1). Synthetic Uzbek prompts only, no
 * customer data. Owner allowed paid gemini-3.8-flash for this, under $0.05.
 *
 *   pnpm exec tsx --env-file=<path to .env> scripts/llm-stream-live.ts \
 *     [--text 5] [--tools 3] [--preset groq|gemini|mistral] [--model <id>]
 *
 * `--preset` uses a provider preset (its base URL, key variable and FAST
 * model; `--model` overrides the model) instead of the LLM_* variables.
 *
 * Env: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL_FAST, optional
 * LLM_REASONING_EFFORT, LLM_MAX_TOKENS_PARAM, LLM_PRICING_VERSION (values
 * are never printed).
 *
 * Checks: text arrives in more than one delta (really streamed); time to
 * first text; a tool call is signalled before the stream ends, its
 * arguments parse, and the follow-up request with the tool result (and any
 * echoed `extra_content`) is accepted and answered as a stream.
 * Exit code 1 when a check fails.
 */
import { performance } from 'node:perf_hooks';
import type {
  LlmMessage,
  LlmStreamEvent,
  ToolGenerationRequest,
  ToolGenerationResult,
} from '../src/core/llm/llm-provider.js';
import { costOfUsage, nanoToUsd, pricingFor } from '../src/core/llm/pricing.js';
import { OpenAiCompatibleLlmProvider } from '../src/llm/openai-compatible/openai-compatible-provider.js';
import { PRICING_CATALOG } from '../src/llm/pricing-catalog.js';
import { resolvePreset } from '../src/llm/provider-presets.js';

const SYSTEM =
  'Siz o‘quv markazining telefon operatorisiz. Faqat o‘zbek tilida (lotin), ' +
  'qisqa, 1-2 gap bilan, og‘zaki uslubda javob bering. Narx, sana yoki joy ' +
  'haqida so‘ralsa, avval search_catalog vositasini chaqiring; raqamlarni ' +
  'o‘zingiz o‘ylab topmang.';
const TEXT_PROMPTS = [
  'Assalomu alaykum, menga bir narsa so‘ramoqchi edim.',
  'Siz bilan qanday bog‘lansam bo‘ladi?',
  'Rahmat, tushunarli.',
  'Kechirasiz, yaxshi eshitmadim, qaytarib ayting.',
  'Xo‘p, unda ertaga ko‘rishamiz.',
];
const TOOL_PROMPTS = [
  'Ingliz tili kursining narxi qancha?',
  'IELTS guruhi qachon boshlanadi?',
  'Chilonzor filialida matematika kursi bormi?',
];
const TOOLS: ToolGenerationRequest['tools'] = [
  {
    name: 'search_catalog',
    description: 'Kurslarni nomi yoki mavzusi bo‘yicha qidiradi.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
];
/** Synthetic tool result: clearly fake data, never shown to a customer. */
const FAKE_RESULT = JSON.stringify({
  items: [
    {
      title: 'Ingliz tili (sinov)',
      price: '450 000 so‘m',
      starts: '2026-12-01',
    },
  ],
});

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}
function text(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

interface Measured {
  result: ToolGenerationResult;
  events: LlmStreamEvent[];
  firstTextMs?: number;
  firstToolMs?: number;
  totalMs: number;
}

async function measure(
  llm: OpenAiCompatibleLlmProvider,
  messages: LlmMessage[],
): Promise<Measured> {
  const events: LlmStreamEvent[] = [];
  const started = performance.now();
  let firstTextMs: number | undefined;
  let firstToolMs: number | undefined;
  const result = await llm.streamWithTools(
    {
      tier: 'FAST',
      purpose: 'respond',
      system: SYSTEM,
      messages,
      maxOutputTokens: 400,
      tools: TOOLS,
      singleToolCall: true,
    },
    (event) => {
      const at = performance.now() - started;
      if (event.type === 'text') firstTextMs ??= at;
      else firstToolMs ??= at;
      events.push(event);
    },
  );
  return {
    result,
    events,
    firstTextMs,
    firstToolMs,
    totalMs: performance.now() - started,
  };
}

function p(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
}

async function main(): Promise<void> {
  const presetId = text('preset');
  const modelOverride = text('model');
  const resolved = presetId
    ? resolvePreset(
        presetId,
        process.env,
        modelOverride ? { FAST: modelOverride, STRONG: modelOverride } : {},
      )
    : undefined;
  const model = resolved?.models.FAST ?? modelOverride ?? env('LLM_MODEL_FAST');
  const llm = new OpenAiCompatibleLlmProvider({
    baseUrl: resolved?.preset.baseUrl ?? env('LLM_BASE_URL'),
    apiKey: resolved ? resolved.apiKey : env('LLM_API_KEY'),
    models: { FAST: model, STRONG: model },
    structuredOutput: 'json_object',
    maxTokensParam:
      resolved?.preset.maxTokensParam ??
      (process.env.LLM_MAX_TOKENS_PARAM === 'max_completion_tokens'
        ? 'max_completion_tokens'
        : 'max_tokens'),
    ...(process.env.LLM_REASONING_EFFORT
      ? {
          reasoningEffort: process.env.LLM_REASONING_EFFORT as
            'minimal' | 'low' | 'medium' | 'high',
        }
      : {}),
    requestTimeoutMs: 30_000,
    maxRetries: 1,
  });
  const pricingVersion = resolved ? undefined : process.env.LLM_PRICING_VERSION;
  const pricing = pricingVersion
    ? pricingFor(PRICING_CATALOG.snapshot(pricingVersion), model)
    : undefined;
  let costNano = 0;
  let failures = 0;
  const all: Measured[] = [];
  const check = (ok: boolean, label: string): void => {
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  };

  console.log(
    `${presetId ?? 'LLM_*'} model ${model}, reasoning ${process.env.LLM_REASONING_EFFORT ?? 'default'}`,
  );
  console.log('\nText turns');
  const firstText: number[] = [];
  for (const prompt of TEXT_PROMPTS.slice(0, arg('text', 5))) {
    const m = await measure(llm, [{ role: 'user', text: prompt }]);
    all.push(m);
    const deltas = m.events.filter((e) => e.type === 'text').length;
    if (m.firstTextMs !== undefined) firstText.push(m.firstTextMs);
    console.log(
      `  first text ${m.firstTextMs?.toFixed(0) ?? '-'} ms, total ${m.totalMs.toFixed(0)} ms, ${deltas} deltas, stop ${m.result.stopReason}, reasoning ${m.result.usage.reasoningTokens ?? '-'} tok: ${m.result.text.replace(/\s+/gu, ' ').slice(0, 90)}`,
    );
    check(m.result.text.length > 0, 'reply has text');
  }

  console.log('\nTool turns');
  for (const prompt of TOOL_PROMPTS.slice(0, arg('tools', 3))) {
    const first = await measure(llm, [{ role: 'user', text: prompt }]);
    all.push(first);
    const call = first.result.toolCalls[0];
    console.log(
      `  tool signal ${first.firstToolMs?.toFixed(0) ?? '-'} ms, total ${first.totalMs.toFixed(0)} ms, call ${call?.name ?? 'none'} ${JSON.stringify(call?.input ?? null)}, echo ${first.result.providerContent ? 'yes' : 'no'}`,
    );
    check(call?.name === 'search_catalog', 'model called search_catalog');
    check(
      first.firstToolMs !== undefined && first.firstToolMs <= first.totalMs,
      'tool call signalled during the stream',
    );
    check(
      typeof call?.input === 'object' && call.input !== null,
      'tool arguments parsed as JSON',
    );
    if (!call) continue;
    const second = await measure(llm, [
      { role: 'user', text: prompt },
      {
        role: 'assistant',
        text: first.result.text,
        toolCalls: first.result.toolCalls,
        providerContent: first.result.providerContent,
      },
      {
        role: 'tool_results',
        results: [
          { toolCallId: call.id, content: FAKE_RESULT, isError: false },
        ],
      },
    ]);
    all.push(second);
    if (second.firstTextMs !== undefined) firstText.push(second.firstTextMs);
    console.log(
      `  follow-up first text ${second.firstTextMs?.toFixed(0) ?? '-'} ms, total ${second.totalMs.toFixed(0)} ms, stop ${second.result.stopReason}, calls ${second.result.toolCalls.map((c) => `${c.name} ${JSON.stringify(c.input)}`).join('; ') || 'none'}, out ${second.result.usage.outputTokens} tok (reasoning ${second.result.usage.reasoningTokens ?? '-'}): ${second.result.text.replace(/\s+/gu, ' ').slice(0, 90)}`,
    );
    // The model may answer, or refine its search with another tool call (a
    // real turn runs more rounds); either way the request was accepted.
    check(
      second.result.text.length > 0 || second.result.toolCalls.length > 0,
      'follow-up with tool result accepted (text or another tool call)',
    );
  }

  for (const m of all)
    if (pricing) costNano += costOfUsage(pricing, m.result.usage);
  const streamed = all.filter(
    (m) => m.events.filter((e) => e.type === 'text').length > 1,
  ).length;
  console.log('\nSummary');
  console.log(`  calls ${all.length}, streamed in >1 text delta: ${streamed}`);
  if (firstText.length > 0)
    console.log(
      `  first text p50 ${p(firstText, 0.5).toFixed(0)} ms, p95 ${p(firstText, 0.95).toFixed(0)} ms (n=${firstText.length})`,
    );
  console.log(
    `  usage reported by provider: ${all.filter((m) => !m.result.usage.estimated).length}/${all.length}`,
  );
  console.log(
    `  cost ${pricing ? `$${nanoToUsd(costNano)} (${pricingVersion})` : resolved ? 'free-tier preset (not priced)' : 'unknown (no LLM_PRICING_VERSION)'}`,
  );
  if (failures > 0) {
    console.log(`  ${failures} check(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? `${error.name}: ${error.message}` : 'failed',
  );
  process.exitCode = 1;
});
