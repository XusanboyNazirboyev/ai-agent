import type { Prisma } from '../generated/prisma/client.js';

export type TransactionClient = Prisma.TransactionClient;

/**
 * The per-conversation advisory lock shared with the webhook, the echo path
 * and the agent pipeline (same key): one writer per conversation, so bot
 * commits and operator commands can never interleave.
 */
export async function lockConversation(
  tx: TransactionClient,
  tenantId: string,
  conversationId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`agentcore:${tenantId}:${conversationId}`}, 0))) AS lock_result`;
}
