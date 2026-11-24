import type { Prisma } from '../../generated/prisma/client.js';

/**
 * ADR 090: a customer's reply to one of the business's Instagram stories.
 * Meta sends `message.reply_to.story { url, id }` with the text ("Webhooks",
 * Instagram Messaging, read 2026-11-24). Kept in `messages.rich_content` of
 * the inbound message: built by code from the webhook, never typed by the
 * customer. The URL is Meta's CDN link to our own story, short-lived.
 */
export type StoryReply = {
  readonly kind: 'story_reply';
  readonly storyId: string | null;
  readonly url: string | null;
};

export function storyReplyContent(story: {
  id?: string | undefined;
  url?: string | undefined;
}): StoryReply & Prisma.InputJsonObject {
  return {
    kind: 'story_reply',
    storyId: story.id ?? null,
    url: story.url ?? null,
  };
}

export function isStoryReply(value: unknown): value is StoryReply {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'story_reply'
  );
}
