# ADR 090 — Replies to Instagram stories

Status: built 2026-11-24 in autonomous mode (owner 2026-11-15); item 3 of the competitor gaps ([research](../research/competitors-2026-11-24.md)). Owner review pending.

## Context
- Customers often answer a story with "narxi qancha?" or "bormi?". The bot already received these as ordinary direct messages, but did not know they referred to a story, so it could guess the product.
- Meta (Instagram Messaging "Webhooks", https://developers.facebook.com/documentation/business-messaging/instagram-messaging/webhooks, read 2026-11-24): a story reply arrives in the `messages` field with `message.text` and `message.reply_to.story { url, id }` (`url` is a CDN link); story replies with a GIF or sticker send no webhook; story mentions come as a `story_mention` attachment.

## Decisions
1. The normalizer keeps `reply_to.story` (read leniently: an unexpected shape only drops the mark, never the message; a URL over 2,000 characters is dropped).
2. The inbound message stores `rich_content = { kind: 'story_reply', storyId, url }` (code-built from the webhook; no migration). `rich_content` was outbound-only (ADR 044) until now.
3. The agent turn gets `origin: 'story_reply'` when its batch holds a story reply; every prompt that carries the latest message adds a code-written note: the message answers one of the business's stories, the story is not visible, and an unnamed "this / the price / is it available" is asked about, not guessed. Everything else (facts from tools, guardrails, handover) is unchanged.
4. The Inbox shows "Replied to your Instagram story" on such messages; the CDN link is not passed to the browser.

## Not done
- The story's picture or caption is not read: our model calls are text-only, and the Graph API story fields were not checked. A later step could fetch the story's media type and caption, or show the image to operators.
- Story mentions (a customer tags the business in their own story) stay ignored: they carry no question.

## Consequences
- Fewer wrong answers to "narxi qancha?" under a story; the bot asks which product.
- Not verified with a live Instagram story reply.
