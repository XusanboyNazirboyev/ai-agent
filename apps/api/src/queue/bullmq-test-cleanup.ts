import { Queue } from 'bullmq';

const TEST_PREFIX_RE = /^agentcore-test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidTestPrefix(prefix: string): boolean {
  return TEST_PREFIX_RE.test(prefix);
}

export async function cleanupTestQueue(prefix: string, queueName: string): Promise<void> {
  if (!isValidTestPrefix(prefix)) {
    throw new Error(`Refusing cleanup for non-test prefix: ${prefix}`);
  }
  const queue = new Queue(queueName, { prefix, connection: { host: '127.0.0.1', port: 6379 } });
  await queue.obliterate({ force: true });
  await queue.close();
}
