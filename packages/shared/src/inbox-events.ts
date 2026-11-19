import { z } from 'zod';

const eventIdSchema = z.string().regex(/^\d{1,18}$/u);
const uuidSchema = z.string().uuid();
const nullableUuidSchema = uuidSchema.nullable();

const conversationUpdatedSchema = z
  .object({
    type: z.literal('conversation.updated'),
    conversationId: uuidSchema,
    handoverId: z.null(),
    messageId: z.null(),
  })
  .strict();

const messageCreatedSchema = z
  .object({
    type: z.literal('message.created'),
    conversationId: uuidSchema,
    handoverId: z.null(),
    messageId: uuidSchema,
  })
  .strict();

const handoverCreatedSchema = z
  .object({
    type: z.literal('handover.created'),
    conversationId: uuidSchema,
    handoverId: uuidSchema,
    messageId: z.null(),
  })
  .strict();

const handoverSlaBreachedSchema = z
  .object({
    type: z.literal('handover.sla_breached'),
    conversationId: uuidSchema,
    handoverId: uuidSchema,
    messageId: z.null(),
  })
  .strict();

const subscriptionBotPausedSchema = z
  .object({
    type: z.literal('subscription.bot_paused'),
    conversationId: nullableUuidSchema,
    handoverId: z.null(),
    messageId: z.null(),
  })
  .strict();

const subscriptionPastDueSchema = z
  .object({
    type: z.literal('subscription.past_due'),
    conversationId: nullableUuidSchema,
    handoverId: z.null(),
    messageId: z.null(),
  })
  .strict();

const subscriptionExpiredSchema = z
  .object({
    type: z.literal('subscription.expired'),
    conversationId: nullableUuidSchema,
    handoverId: z.null(),
    messageId: z.null(),
  })
  .strict();

/** ADR 068: a task's time came; the title is for the browser notification. */
const taskDueSchema = z
  .object({
    type: z.literal('task.due'),
    conversationId: nullableUuidSchema,
    handoverId: z.null(),
    messageId: z.null(),
    // Events written before the title existed carry none.
    taskTitle: z.string().max(200).nullable().optional(),
  })
  .strict();

const eventDataVariants = [
  conversationUpdatedSchema,
  messageCreatedSchema,
  handoverCreatedSchema,
  handoverSlaBreachedSchema,
  subscriptionBotPausedSchema,
  subscriptionPastDueSchema,
  subscriptionExpiredSchema,
  taskDueSchema,
] as const;

/** Validated JSON payload carried in the SSE data field (event name is separate). */
export const InboxEventDataSchema = z.discriminatedUnion(
  'type',
  eventDataVariants,
);

/** Validated database event record, including its numeric SSE resume cursor. */
export const InboxEventRecordSchema = z.discriminatedUnion('type', [
  conversationUpdatedSchema.extend({ id: eventIdSchema }),
  messageCreatedSchema.extend({ id: eventIdSchema }),
  handoverCreatedSchema.extend({ id: eventIdSchema }),
  handoverSlaBreachedSchema.extend({ id: eventIdSchema }),
  subscriptionBotPausedSchema.extend({ id: eventIdSchema }),
  subscriptionPastDueSchema.extend({ id: eventIdSchema }),
  subscriptionExpiredSchema.extend({ id: eventIdSchema }),
  taskDueSchema.extend({ id: eventIdSchema }),
]);

export type InboxEventData = z.infer<typeof InboxEventDataSchema>;
export type InboxEventRecord = z.infer<typeof InboxEventRecordSchema>;
