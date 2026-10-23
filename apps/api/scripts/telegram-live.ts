/**
 * Test-only Telegram helper. `check` reports which required variables are
 * missing (names only) and stops. `register` calls setWebhook with
 * allowed_updates including callback_query. Never prints the token or secret.
 *
 *   pnpm --filter api telegram:live check
 *   pnpm --filter api telegram:live register
 */
const REQUIRED = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'TELEGRAM_CHANNEL_ACCOUNT_ID',
  'TELEGRAM_TEST_PUBLIC_URL',
] as const;

const missing = REQUIRED.filter((name) => !process.env[name]);
const command = process.argv[2];

if (missing.length > 0) {
  console.log(
    `LIVE TEST NOT RUN. Missing environment variables: ${missing.join(', ')}`,
  );
  console.log(
    'Also required in the database: the test channel account has operator_chat_id (a test group) and is_test_account=true.',
  );
  process.exit(command === 'check' ? 0 : 2);
}

if (command === 'register') {
  const base = process.env.TELEGRAM_TEST_PUBLIC_URL!.replace(/\/+$/u, '');
  if (!base.startsWith('https://')) {
    console.log(
      'TELEGRAM_TEST_PUBLIC_URL must be an https URL (Telegram requires it).',
    );
    process.exit(2);
  }
  const response = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${base}/webhooks/telegram/${process.env.TELEGRAM_CHANNEL_ACCOUNT_ID}`,
        secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
      }),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
  };
  console.log(`setWebhook: ok=${String(body.ok)} http=${response.status}`);
  process.exit(body.ok ? 0 : 1);
} else {
  console.log(
    'All required variables are present. Run with "register" to set the webhook.',
  );
}

export {};
