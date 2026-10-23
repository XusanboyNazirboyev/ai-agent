import { z } from 'zod';
import { LlmError } from '../core/llm/llm-provider.js';
import { OpenAiCompatibleLlmProvider } from './openai-compatible/openai-compatible-provider.js';
import type { ProviderPreset } from './provider-presets.js';

/**
 * Capability smoke test for one provider/model: three tiny calls (plain
 * chat, one trivial tool call, one JSON-schema output), each capped at 200
 * output tokens. Uses the production adapter. Never prints or returns the
 * key; error text is the typed LlmError message (already secret-free).
 */

export interface SmokeResult {
  readonly provider: string;
  readonly model: string;
  readonly chat: 'ok' | string;
  readonly tools: 'yes' | 'no' | string;
  readonly jsonSchema: 'yes' | 'no' | string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usageReported: boolean;
}

const describeError = (error: unknown): string =>
  error instanceof LlmError ? `${error.code}` : 'ERROR';

export async function smokeProvider(options: {
  readonly preset: ProviderPreset;
  readonly model: string;
  readonly apiKey: string | undefined;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<SmokeResult> {
  const { preset, model } = options;
  const adapter = new OpenAiCompatibleLlmProvider({
    providerId: preset.id,
    baseUrl: preset.baseUrl,
    apiKey: options.apiKey,
    models: { FAST: model, STRONG: model },
    structuredOutput: 'json_schema',
    maxTokensParam: preset.maxTokensParam,
    requestTimeoutMs: options.timeoutMs ?? 20_000,
    maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const base = {
    tier: 'FAST' as const,
    purpose: 'evaluate' as const,
    maxOutputTokens: 200,
  };
  let latency = 0;
  let input = 0;
  let output = 0;
  let reported = true;
  const note = (r: {
    durationMs: number;
    usage: { inputTokens: number; outputTokens: number; estimated?: boolean };
  }): void => {
    latency += r.durationMs;
    input += r.usage.inputTokens;
    output += r.usage.outputTokens;
    if (r.usage.estimated) reported = false;
  };

  let chat = 'ok';
  try {
    note(
      await adapter.generateWithTools({
        ...base,
        system: 'Reply with the single word OK.',
        messages: [{ role: 'user', text: 'ping' }],
        tools: [],
      }),
    );
  } catch (error: unknown) {
    chat = describeError(error);
  }

  let tools: string;
  try {
    const r = await adapter.generateWithTools({
      ...base,
      system: 'Call the ping tool. Do not answer in text.',
      messages: [{ role: 'user', text: 'Call ping with value "x".' }],
      tools: [
        {
          name: 'ping',
          description: 'Returns pong.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['value'],
            properties: { value: { type: 'string' } },
          },
        },
      ],
    });
    note(r);
    tools = r.toolCalls.some((c) => c.name === 'ping') ? 'yes' : 'no';
  } catch (error: unknown) {
    tools = describeError(error);
  }

  let jsonSchema: string;
  try {
    const r = await adapter.generateStructured({
      ...base,
      system: 'Return the JSON object requested.',
      messages: [{ role: 'user', text: 'Return ok=true.' }],
      schemaName: 'smoke',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
      schema: z.object({ ok: z.boolean() }).strict(),
    });
    note(r);
    jsonSchema = r.value?.ok === true ? 'yes' : 'no';
  } catch (error: unknown) {
    jsonSchema = describeError(error);
  }
  return {
    provider: preset.id,
    model,
    chat,
    tools,
    jsonSchema,
    latencyMs: latency,
    inputTokens: input,
    outputTokens: output,
    usageReported: reported,
  };
}

export function renderStatus(
  results: ReadonlyArray<SmokeResult | { provider: string; skipped: string }>,
  date: string,
): string {
  const lines = [
    '# LLM provider status (smoke test)',
    '',
    `Run ${date}. Three tiny calls per provider (chat, one tool call, one JSON-schema output), max 200 output tokens each. Results are a point-in-time observation of THIS account; they do not prove behavior under load or on other models. Fake data only.`,
    '',
    '| Provider | Model | Chat | Tool call | json_schema | Latency ms | Tokens in/out | Usage reported |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    lines.push(
      'skipped' in r
        ? `| ${r.provider} | — | skipped: ${r.skipped} | | | | | |`
        : `| ${r.provider} | ${r.model} | ${r.chat} | ${r.tools} | ${r.jsonSchema} | ${r.latencyMs} | ${r.inputTokens}/${r.outputTokens} | ${r.usageReported ? 'yes' : 'no (estimated)'} |`,
    );
  }
  lines.push(
    '',
    'Codes such as `LLM_RATE_LIMITED` or `LLM_INVALID_REQUEST` are the typed error the adapter raised; `no` means the call succeeded but the capability was not shown.',
    '',
  );
  return lines.join('\n');
}
