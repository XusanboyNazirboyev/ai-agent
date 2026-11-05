import type { ChannelSecretStore } from '../../secrets/channel-secret-store.js';

/**
 * The credential an Instagram account was connected with (ADR 031): a
 * Business Integration System User token from Unified login (sends through
 * graph.facebook.com) or an Instagram User access token pasted by hand
 * (sends through graph.instagram.com). A reconnect removes the other kind,
 * so at most one is stored; the Unified login token wins if both exist.
 */
export type InstagramCredential =
  | { readonly kind: 'unified'; readonly token: string }
  | { readonly kind: 'instagram'; readonly token: string };

/** Throws what the store throws (not configured, unreadable); undefined when none is stored. */
export async function readInstagramCredential(
  secrets: ChannelSecretStore,
  owner: { tenantId: string; channelAccountId: string },
): Promise<InstagramCredential | undefined> {
  const unified = await secrets.get(owner, 'instagram_system_user_token');
  if (unified) return { kind: 'unified', token: unified };
  const user = await secrets.get(owner, 'instagram_access_token');
  return user ? { kind: 'instagram', token: user } : undefined;
}
