import { TenantRetentionSettingsSchema } from '@agentcore/shared';

export interface EffectiveRetention {
  /** Purge inbound_events older than this many minutes (by expiresAt or receivedAt fallback). */
  inboundEventMinutes: number | null;
  /** Purge messages older than this many days when configured. */
  messageDays: number | null;
  /** Purge conversations older than this many days when configured. */
  conversationDays: number | null;
}

const EMPTY: EffectiveRetention = {
  inboundEventMinutes: null,
  messageDays: null,
  conversationDays: null,
};

/**
 * Reads tenant retention settings defensively: unknown/malformed values fail
 * closed to "keep" (null) so a bad config never triggers mass deletion.
 */
export function parseRetentionSettings(value: unknown): EffectiveRetention {
  const parsed = TenantRetentionSettingsSchema.safeParse(value ?? {});
  if (!parsed.success) return EMPTY;
  const d = parsed.data;
  return {
    inboundEventMinutes:
      typeof d.inboundEventMinutes === 'number' ? d.inboundEventMinutes : null,
    messageDays: typeof d.messageDays === 'number' ? d.messageDays : null,
    conversationDays:
      typeof d.conversationDays === 'number' ? d.conversationDays : null,
  };
}

export function inboundEventExpiresAt(
  settings: EffectiveRetention,
  receivedAt: Date,
): Date | null {
  if (settings.inboundEventMinutes === null) return null;
  return new Date(receivedAt.getTime() + settings.inboundEventMinutes * 60_000);
}
