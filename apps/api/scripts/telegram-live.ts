/**
 * Test-only Telegram helper. `check` reports which required variables are
 * missing (names only) and stops. `register` calls setWebhook with
 * allowed_updates including callback_query. Never prints the token or secret.
 *
 *   pnpm --filter api telegram:live check
 *   pnpm --filter api telegram:live register
 */
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { buildSetWebhookPayload } from '../src/dev/dev-guards.js';

loadEnv({ path: resolve(process.cwd(), '../../.env') });

const REQUIRED = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'TELEGRAM_CHANNEL_ACCOUNT_ID',
  'TELEGRAM_TEST_PUBLIC_URL',
] as const;

const command = process.argv[2];
const needed =
  command === 'delete' || command === 'info'
    ? (['TELEGRAM_BOT_TOKEN'] as const)
    : REQUIRED;
const missing = needed.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.log(
    `LIVE TEST NOT RUN. Missing environment variables: ${missing.join(', ')}`,
  );
  console.log(
    'Also required in the database: the test channel account has operator_chat_id (a test group) and is_test_account=true.',
  );
  process.exit(command === 'check' ? 0 : 2);
}

/** Calls a Bot API method. Never prints the URL, token or an error object. */
async function callBotApi(
  method: string,
  payload: Record<string, unknown>,
): Promise<{ ok?: boolean; description?: string; result?: unknown }> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      },
    );
    return (await response.json()) as { ok?: boolean; description?: string };
  } catch {
    return { ok: false, description: 'network error' };
  }
}

if (command === 'register') {
  const base = process.env.TELEGRAM_TEST_PUBLIC_URL!.replace(/\/+$/u, '');
  if (!base.startsWith('https://')) {
    console.log(
      'TELEGRAM_TEST_PUBLIC_URL must be an https URL (Telegram requires it).',
    );
    process.exit(2);
  }
  // Pending updates are kept unless TELEGRAM_DROP_PENDING_UPDATES=true is set
  // explicitly; true DISCARDS every update Telegram holds for the bot.
  const body = await callBotApi(
    'setWebhook',
    buildSetWebhookPayload(process.env, base),
  );
  console.log(
    `setWebhook: ok=${String(body.ok)} ${body.ok ? '' : String(body.description)}`,
  );
  process.exit(body.ok ? 0 : 1);
} else if (command === 'delete') {
  // Keeps pending updates (drop_pending_updates=false) so nothing is lost.
  const body = await callBotApi('deleteWebhook', {
    drop_pending_updates: false,
  });
  console.log(`deleteWebhook: ok=${String(body.ok)}`);
  process.exit(body.ok ? 0 : 1);
} else if (command === 'info') {
  const body = await callBotApi('getWebhookInfo', {});
  const info = (body.result ?? {}) as {
    url?: string;
    pending_update_count?: number;
    last_error_message?: string;
    allowed_updates?: string[];
  };
  console.log(
    JSON.stringify({
      registered: Boolean(info.url),
      pending: info.pending_update_count,
      allowed_updates: info.allowed_updates,
      last_error: info.last_error_message,
    }),
  );
} else {
  console.log(
    'All required variables are present. Commands: check | register | delete | info.',
  );
}

export {};
