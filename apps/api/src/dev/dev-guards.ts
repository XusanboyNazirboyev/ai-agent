const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Dev-only scripts run only with NODE_ENV=development against a local database. */
export function assertLocalDevelopment(
  env: Record<string, string | undefined>,
): void {
  if (env.NODE_ENV !== 'development')
    throw new Error('This script requires NODE_ENV=development');
  if (!LOCAL_HOSTS.has(env.POSTGRES_HOST ?? ''))
    throw new Error('This script only targets a database on localhost');
}

/**
 * The only request the public tunnel may reach: POST of the webhook of one
 * channel account. Everything else (health, operator API, other accounts,
 * other methods, query strings, path tricks) is refused.
 */
export function isAllowedWebhookRequest(
  method: string | undefined,
  url: string | undefined,
  channelAccountId: string,
): boolean {
  return method === 'POST' && url === `/webhooks/telegram/${channelAccountId}`;
}
