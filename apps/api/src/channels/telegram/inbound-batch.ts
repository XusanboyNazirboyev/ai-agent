import type { Prisma } from '../../generated/prisma/client.js';

type TransactionClient = Prisma.TransactionClient;

export function jsonString(
  value: Prisma.JsonValue,
  key: string,
): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const field = value[key];
    return typeof field === 'string' ? field : null;
  }
  return null;
}

export function compareProviderIds(left: string, right: string): number {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}

export interface InboundBatch {
  /** Inbound event ids in provider order. */
  readonly eventIds: readonly string[];
  /** Provider message id of the last message in the batch. */
  readonly lastProviderMessageId: string;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly sequence: number;
  }>;
  /** Message texts joined with newlines (at most 4,096 characters). */
  readonly text: string;
}

/**
 * Debounced batch selection (Phase 2, ADR 005), shared by the echo path and
 * the agent path. Must run inside the conversation's advisory-lock
 * transaction. Pending RECEIVED events are ordered by provider message id;
 * events at or below the last PROCESSED message are late and marked FAILED;
 * at most four messages are merged, within Telegram's 4,096-character limit.
 */
export async function selectInboundBatch(
  tx: TransactionClient,
  tenantId: string,
  channelAccountId: string,
  conversationId: string,
): Promise<InboundBatch | null> {
  const pending = await tx.inboundEvent.findMany({
    where: {
      tenantId,
      channelAccountId,
      status: 'RECEIVED',
      redactedPayload: {
        path: ['conversationId'],
        equals: conversationId,
      },
    },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    take: 100,
  });
  const candidates = pending
    .map((candidate) => ({
      event: candidate,
      messageId: jsonString(candidate.redactedPayload, 'providerMessageId'),
      storedMessageId: jsonString(candidate.redactedPayload, 'messageId'),
    }))
    .filter(
      (
        candidate,
      ): candidate is typeof candidate & {
        messageId: string;
        storedMessageId: string;
      } => Boolean(candidate.messageId && candidate.storedMessageId),
    )
    .sort((a, b) => compareProviderIds(a.messageId, b.messageId));

  if (candidates.length === 0) return null;
  const previous = await tx.inboundEvent.findFirst({
    where: {
      tenantId,
      channelAccountId,
      status: 'PROCESSED',
      redactedPayload: {
        path: ['conversationId'],
        equals: conversationId,
      },
    },
    orderBy: { processedAt: 'desc' },
  });
  const cursor = previous
    ? jsonString(previous.redactedPayload, 'providerMessageId')
    : null;
  const late = cursor
    ? candidates.filter(
        (candidate) => compareProviderIds(candidate.messageId, cursor) <= 0,
      )
    : [];
  for (const candidate of late) {
    await tx.inboundEvent.updateMany({
      where: {
        id: candidate.event.id,
        tenantId,
        status: 'RECEIVED',
      },
      data: { status: 'FAILED' },
    });
  }
  let batch = candidates
    .filter((candidate) => !late.includes(candidate))
    .slice(0, 4);
  if (batch.length === 0) return null;

  const messages = await tx.message.findMany({
    where: {
      id: { in: batch.map((candidate) => candidate.storedMessageId) },
      tenantId,
      direction: 'INBOUND',
    },
    select: { id: true, text: true, sequence: true },
  });
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const orderedMessages = batch
    .map((candidate) => messageById.get(candidate.storedMessageId))
    .filter((message) => message !== undefined);
  if (orderedMessages.length !== batch.length) {
    throw new Error('Durable inbound message is missing');
  }

  let text = '';
  let fitCount = 0;
  for (const message of orderedMessages) {
    const nextText = text ? `${text}\n${message.text}` : message.text;
    if (nextText.length > 4_096) break;
    text = nextText;
    fitCount += 1;
  }
  batch = batch.slice(0, fitCount);
  if (batch.length === 0)
    throw new Error('Inbound text exceeds Telegram reply limit');

  return {
    eventIds: batch.map((candidate) => candidate.event.id),
    lastProviderMessageId: batch.at(-1)!.messageId,
    messages: orderedMessages.slice(0, fitCount),
    text,
  };
}
