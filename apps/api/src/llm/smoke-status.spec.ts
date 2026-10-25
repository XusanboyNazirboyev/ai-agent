import { describe, expect, it } from 'vitest';
import { mergeStatus, renderStatus } from './smoke.js';

const existing = [
  '# LLM provider status (smoke test)',
  '',
  'Run 2026-10-23. Three tiny calls per provider.',
  '',
  '| Provider | Model | Chat | Tool call | json_schema | Latency ms | Tokens in/out | Usage reported |',
  '|---|---|---|---|---|---|---|---|',
  '| groq | openai/gpt-oss-20b | ok | yes | yes | 2336 | 394/287 | yes |',
  '| gemini | gemini-3.5-flash-lite | ok | yes | yes | 19416 | 81/24 | yes |',
  '| mistral | mistral-small-latest | LLM_RATE_LIMITED | LLM_RATE_LIMITED | LLM_RATE_LIMITED | 0 | 0/0 | yes |',
  '',
  'Codes such as `LLM_RATE_LIMITED` are typed errors.',
  '',
  "## Observations (2026-10-23, this project's accounts)",
  '- **Gemini:** hand-written note that must survive.',
  '',
].join('\n');

describe('smoke status document merge', () => {
  const fresh = renderStatus(
    [
      {
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
        chat: 'ok',
        tools: 'yes',
        jsonSchema: 'yes',
        latencyMs: 1636,
        inputTokens: 394,
        outputTokens: 261,
        usageReported: true,
      } as never,
    ],
    '2026-10-25',
  );

  it('replaces only the tested provider row and keeps the others and the notes', () => {
    const merged = mergeStatus(existing, fresh, '2026-10-25');
    expect(merged).toContain(
      '| groq | openai/gpt-oss-20b | ok | yes | yes | 1636 | 394/261 | yes |',
    );
    expect(merged).not.toContain('| 2336 |');
    expect(merged).toContain('| gemini | gemini-3.5-flash-lite |');
    expect(merged).toContain('| mistral | mistral-small-latest |');
    expect(merged).toContain('hand-written note that must survive');
    expect(merged).toContain('Rows updated 2026-10-25: groq.');
    expect(merged.match(/\| groq \|/gu)).toHaveLength(1);
  });

  it('appends a provider that had no row and is idempotent', () => {
    const llm7 = renderStatus(
      [{ provider: 'llm7', skipped: 'no default model' }],
      '2026-10-25',
    );
    const once = mergeStatus(existing, llm7, '2026-10-25');
    expect(once).toContain('| llm7 | — | skipped: no default model |');
    expect(mergeStatus(once, llm7, '2026-10-25')).toBe(once);
  });

  it('writes the fresh document when none exists', () => {
    expect(mergeStatus(undefined, fresh, '2026-10-25')).toBe(fresh);
  });
});
