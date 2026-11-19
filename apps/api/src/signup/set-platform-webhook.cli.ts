/**
 * Server command (ADR 080): points the platform bot's webhook at this API.
 *   pnpm ops:platform-bot-webhook --url https://api.example.com
 * Reads PLATFORM_TELEGRAM_BOT_TOKEN and PLATFORM_TELEGRAM_WEBHOOK_SECRET from
 * the environment (same env file as the API); never prints either. Bot API
 * setWebhook (`url` https, `secret_token`, `allowed_updates`) per
 * https://core.telegram.org/bots/api (read 2026-11-19).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { TelegramManagement } from '../channels/telegram/telegram-management.js';
import { platformWebhookPathSecret } from './signup-rules.js';

async function main(): Promise<void> {
  const envFile = process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const index = process.argv.indexOf('--url');
  const base = index > 0 ? process.argv[index + 1] : undefined;
  const token = process.env.PLATFORM_TELEGRAM_BOT_TOKEN;
  const secret = process.env.PLATFORM_TELEGRAM_WEBHOOK_SECRET;
  if (!base || !/^https:\/\/[^\s/]+$/u.test(base.replace(/\/+$/u, '')))
    throw new Error('usage: --url https://<public API host> (https only)');
  if (!token || !secret)
    throw new Error(
      'PLATFORM_TELEGRAM_BOT_TOKEN and PLATFORM_TELEGRAM_WEBHOOK_SECRET must be set',
    );
  const url = `${base.replace(/\/+$/u, '')}/webhooks/platform-telegram/${platformWebhookPathSecret(secret)}`;
  await new TelegramManagement().setWebhook(token, url, secret);
  console.log('Platform bot webhook set (path secret not printed).');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
