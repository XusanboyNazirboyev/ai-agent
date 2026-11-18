import { config as loadEnv } from 'dotenv';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { LLM_PROVIDER } from '../../agent/agent-conversation.service.js';
import type { LlmProvider } from '../../core/llm/llm-provider.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { traceRequests } from '../../observability/trace-requests.js';
import { createPostgresAdapter } from '../../persistence/postgres-adapter.js';

/**
 * Load test (pilot plan step 5, "a short load test"; spec 09 "load test
 * before launch"). Opt-in, local, no cost:
 *
 *   LOAD_TEST=1 pnpm --filter @agentcore/api test:load
 *
 * Boots the real AppModule in process against agentcore_test (PostgreSQL and
 * Redis as in the integration suite) with LLM_PROVIDER=mock, one fresh tenant
 * with the mock catalog connector and a LIVE Telegram account. Fictional
 * customers send real webhook requests; the Bot API is answered in process
 * (global fetch is replaced before boot; any other outbound host is refused),
 * so nothing leaves the machine.
 *
 * Per message it records the webhook response time and the time from the
 * webhook request to the bot's first sendMessage to that chat (queue, turn,
 * guardrail, commit, outbox relay, send). Stages run one after another with
 * more customers each; every customer sends its messages one by one, the
 * next after the reply and a short pause.
 *
 * Environment: LOAD_STAGES (customers per stage, default "5,20,50"),
 * LOAD_MESSAGES (per customer, default 4), LOAD_LLM_DELAY_MS (added to every
 * model call, default 0), LOAD_THINK_MS (pause after a reply, default 200),
 * LOAD_REPLY_TIMEOUT_MS (default 30000); TELEGRAM_QUEUE_CONCURRENCY is passed
 * through to the app.
 *
 * Shows: platform overhead and its growth with concurrency on this machine.
 * Does not show: real model latency or cost (mock, optional fixed delay),
 * Telegram's own limits, the staging instance size, network, or other packs.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

const ENABLED = process.env.LOAD_TEST === '1';
const num = (key: string, fallback: number): number => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const STAGES = (process.env.LOAD_STAGES ?? '5,20,50')
  .split(',')
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);
const MESSAGES = num('LOAD_MESSAGES', 4);
const LLM_DELAY_MS = num('LOAD_LLM_DELAY_MS', 0);
const THINK_MS = num('LOAD_THINK_MS', 200);
const REPLY_TIMEOUT_MS = num('LOAD_REPLY_TIMEOUT_MS', 30_000);
const SECRET = `load-${randomUUID()}`;
/** Inbound jobs wait this long to merge rapid messages (ADR 005, spec 06). */
const DEBOUNCE_MS = 2_000;
const TEXTS = [
  'Salom',
  'Qanday kurslar bor?',
  'Narxi qancha?',
  'Rahmat',
  'Ertaga kelsam bo‘ladimi?',
];

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/** Bot API sends per chat id, in arrival order. */
const sends = new Map<number, number[]>();
let botMessageId = 0;
const realFetch = globalThis.fetch;

function fakeBotApi(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    if (url.hostname !== 'api.telegram.org')
      throw new Error(`load test: outbound request refused (${url.hostname})`);
    const method = url.pathname.split('/').pop();
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as { chat_id?: number | string })
        : {};
    // The sender passes the stored chat id, a string.
    const chatId = Number(body.chat_id);
    if (method === 'sendMessage' && Number.isFinite(chatId)) {
      const list = sends.get(chatId) ?? [];
      list.push(performance.now());
      sends.set(chatId, list);
      botMessageId += 1;
      return Response.json({
        ok: true,
        result: {
          message_id: botMessageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'private' },
        },
      });
    }
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;
}

function slowModel(provider: LlmProvider): void {
  if (LLM_DELAY_MS === 0) return;
  const structured = provider.generateStructured.bind(provider);
  const tools = provider.generateWithTools.bind(provider);
  Object.assign(provider, {
    generateStructured: async (request: never) => {
      await sleep(LLM_DELAY_MS);
      return structured(request);
    },
    generateWithTools: async (request: never) => {
      await sleep(LLM_DELAY_MS);
      return tools(request);
    },
    streamWithTools: undefined,
  });
}

const percentile = (sorted: readonly number[], q: number): number =>
  sorted.length === 0
    ? Number.NaN
    : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
const ms = (value: number): string =>
  Number.isNaN(value) ? 'n/a' : `${Math.round(value)}`;

interface StageResult {
  customers: number;
  messages: number;
  webhook: number[];
  reply: number[];
  timeouts: number;
  /** Timeouts by message index (0-based) within a customer's messages. */
  timeoutAt: number[];
  rejected: number;
  /** Non-200 webhook answers: status -> count, with a short body. */
  rejectedBy: Record<string, number>;
  wallMs: number;
}

async function waitForReply(chatId: number, after: number): Promise<number> {
  const deadline = performance.now() + REPLY_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const hit = (sends.get(chatId) ?? []).find((at) => at > after);
    if (hit !== undefined) return hit - after;
    await sleep(10);
  }
  return Number.NaN;
}

async function customer(
  base: string,
  accountId: string,
  chatId: number,
  result: StageResult,
): Promise<void> {
  for (let i = 0; i < MESSAGES; i++) {
    const started = performance.now();
    const response = await fetch(`${base}/webhooks/telegram/${accountId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': SECRET,
      },
      body: JSON.stringify({
        update_id: Math.floor(Math.random() * 2 ** 31),
        message: {
          message_id: i + 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'private' },
          from: { id: chatId, first_name: 'Load' },
          text: TEXTS[i % TEXTS.length],
        },
      }),
    });
    result.webhook.push(performance.now() - started);
    if (response.status !== 200) {
      result.rejected += 1;
      const why = `${response.status} ${(await response.text()).slice(0, 80)}`;
      result.rejectedBy[why] = (result.rejectedBy[why] ?? 0) + 1;
      continue;
    }
    const reply = await waitForReply(chatId, started);
    if (Number.isNaN(reply)) {
      result.timeouts += 1;
      result.timeoutAt[i] = (result.timeoutAt[i] ?? 0) + 1;
      continue;
    }
    result.reply.push(reply);
    await sleep(THINK_MS);
  }
}

describe.skipIf(!ENABLED)('Telegram load test (opt-in)', () => {
  it('measures webhook and reply times per concurrency stage', async () => {
    if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
      throw new Error('The load test runs against agentcore_test only');
    for (const key of [
      'HOST',
      'PORT',
      'DATABASE',
      'USER',
      'PASSWORD',
      'SSL_MODE',
    ]) {
      const value = process.env[`TEST_POSTGRES_${key}`];
      if (value !== undefined) process.env[`POSTGRES_${key}`] = value;
    }
    const db = new PrismaClient({
      adapter: createPostgresAdapter(process.env, 'TEST_'),
    });
    const suffix = randomUUID();
    const tenant = await db.tenant.create({
      data: {
        slug: `load-${suffix}`,
        name: 'Load test (fictional)',
        defaultLocale: 'uz-Latn',
        supportedLocales: ['uz-Latn', 'ru', 'en'],
        timezone: 'Asia/Tashkent',
        packKey: 'education',
        packVersion: '1',
      },
    });
    await db.tenantConnector.create({
      data: {
        tenantId: tenant.id,
        connectorKey: 'mock',
        status: 'ACTIVE',
        config: { sourceSystem: 'mock-education' },
      },
    });
    const account = await db.channelAccount.create({
      data: {
        tenantId: tenant.id,
        channelType: 'telegram',
        externalAccountId: `load-${suffix}`,
        status: 'ACTIVE',
        agentMode: 'LIVE',
        isTestAccount: true,
      },
    });

    fakeBotApi();
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LLM_PROVIDER: 'mock',
      LLM_TRUSTED_PROVIDERS: 'mock',
      // A snapshot that prices the mock model (as the agent specs use).
      LLM_PRICING_VERSION: 'anthropic-2026-10-23',
      RLS_CONTEXT_MODE: 'off',
      TELEGRAM_CHANNEL_ACCOUNT_ID: account.id,
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      TELEGRAM_BOT_TOKEN: '000000:placeholder-not-a-token',
      TELEGRAM_RATE_LIMIT_PER_MINUTE: '10000',
    });
    const { AppModule } = await import('../../app.module.js');
    const app: INestApplication = await NestFactory.create(AppModule, {
      logger: ['error'],
      abortOnError: false,
      rawBody: true,
    });
    app.use(traceRequests);
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    slowModel(app.get<LlmProvider>(LLM_PROVIDER));

    const results: StageResult[] = [];
    const rssStart = process.memoryUsage().rss;
    let nextChat = 7_000_000 + Math.floor(Math.random() * 1_000_000);
    try {
      for (const customers of STAGES) {
        const result: StageResult = {
          customers,
          messages: customers * MESSAGES,
          webhook: [],
          reply: [],
          timeouts: 0,
          timeoutAt: [],
          rejected: 0,
          rejectedBy: {},
          wallMs: 0,
        };
        const started = performance.now();
        await Promise.all(
          Array.from({ length: customers }, () =>
            customer(base, account.id, (nextChat += 1), result),
          ),
        );
        result.wallMs = performance.now() - started;
        results.push(result);
      }
    } finally {
      await app.close();
    }
    const rssEnd = process.memoryUsage().rss;
    const turns = await db.agentTurn.groupBy({
      by: ['status'],
      where: { tenantId: tenant.id },
      _count: { _all: true },
    });
    const handovers = await db.handover.count({
      where: { tenantId: tenant.id },
    });
    const states = await db.conversation.groupBy({
      by: ['state'],
      where: { tenantId: tenant.id },
      _count: { _all: true },
    });
    await db.$disconnect();
    globalThis.fetch = realFetch;

    let commit = 'unknown';
    try {
      commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
    } catch {
      // Not a checkout: the report says unknown.
    }
    const rows = results.map((r) => {
      const webhook = [...r.webhook].sort((a, b) => a - b);
      const reply = [...r.reply].sort((a, b) => a - b);
      const throughput = (r.reply.length / r.wallMs) * 1_000;
      const over = (q: number): string =>
        ms(percentile(reply, q) - DEBOUNCE_MS);
      return `| ${r.customers} | ${r.messages} | ${ms(percentile(webhook, 0.5))} / ${ms(percentile(webhook, 0.95))} | ${ms(percentile(reply, 0.5))} / ${ms(percentile(reply, 0.95))} / ${ms(percentile(reply, 0.99))} / ${ms(reply.at(-1) ?? Number.NaN)} | ${over(0.5)} / ${over(0.95)} | ${throughput.toFixed(1)} | ${r.timeouts} | ${r.rejected} |`;
    });
    const report = [
      '# Telegram load test (fictional customers, mock model)',
      '',
      `Commit ${commit}, ${new Date().toISOString()}, Node ${process.version}, ${process.platform}. Stages ${STAGES.join(', ')} customers × ${MESSAGES} messages, model delay ${LLM_DELAY_MS} ms per call, pause ${THINK_MS} ms, reply timeout ${REPLY_TIMEOUT_MS} ms, queue concurrency ${process.env.TELEGRAM_QUEUE_CONCURRENCY ?? '8 (default)'}. Local PostgreSQL and Redis, one process.`,
      '',
      `Reply times include the ${DEBOUNCE_MS} ms inbound debounce (ADR 005); "above debounce" is the rest (queue, turn, commit, relay, send).`,
      '',
      '| Customers | Messages | Webhook p50 / p95 ms | Reply p50 / p95 / p99 / max ms | Above debounce p50 / p95 ms | Replies/s | Timeouts | Rejected |',
      '|---|---|---|---|---|---|---|---|',
      ...rows,
      '',
      `Timeouts by message number: ${results.map((r) => `${r.customers} customers [${Array.from({ length: MESSAGES }, (_, i) => r.timeoutAt[i] ?? 0).join(', ')}]`).join('; ')}. A conversation handed over waits for a person (D12): the bot stays silent, so the next message has no reply by design.`,
      '',
      `Rejected webhooks: ${results.map((r) => `${r.customers} customers ${JSON.stringify(r.rejectedBy)}`).join('; ')}.`,
      '',
      `Agent turns by status: ${turns.map((t) => `${t.status} ${t._count._all}`).join(', ') || 'none'}. Handovers: ${handovers}. Conversations by state: ${states.map((c) => `${c.state} ${c._count._all}`).join(', ')}. Process RSS ${Math.round(rssStart / 2 ** 20)} -> ${Math.round(rssEnd / 2 ** 20)} MiB.`,
      '',
      'Shows: platform overhead from webhook to the first reply (queue, turn, guardrail, commit, outbox relay, send) and how it grows with concurrent customers on this machine. Does not show: real model latency or cost, Telegram limits, the staging instance, network, or packs other than education.',
    ].join('\n');
    const dir = resolve(process.cwd(), '../../eval/reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(
        dir,
        `load-telegram-${new Date().toISOString().replace(/[:.]/gu, '-')}.md`,
      ),
      `${report}\n`,
    );
    process.stdout.write(`${report}\n`);
    expect(results.every((r) => r.rejected === 0)).toBe(true);
  }, 900_000);
});
