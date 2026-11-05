import type { ChannelSecretStore } from '../../secrets/channel-secret-store.js';

/**
 * The credential an Instagram account was connected with (ADR 031): a
 * Facebook Page access token (Facebook Login for Business, sends through
 * graph.facebook.com) or an Instagram User access token (Instagram Login or a
 * pasted token, sends through graph.instagram.com). A reconnect removes the
 * other kind, so at most one is stored; the Page token wins if both exist.
 */
export type InstagramCredential =
  | { readonly kind: 'page'; readonly token: string }
  | { readonly kind: 'instagram'; readonly token: string };

/** Throws what the store throws (not configured, unreadable); undefined when none is stored. */
export async function readInstagramCredential(
  secrets: ChannelSecretStore,
  owner: { tenantId: string; channelAccountId: string },
): Promise<InstagramCredential | undefined> {
  const page = await secrets.get(owner, 'instagram_page_access_token');
  if (page) return { kind: 'page', token: page };
  const user = await secrets.get(owner, 'instagram_access_token');
  return user ? { kind: 'instagram', token: user } : undefined;
}
