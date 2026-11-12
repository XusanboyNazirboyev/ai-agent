/**
 * Pure assembly of the People API shapes (ADR 052 slice B). No database
 * access: the service batches the reads and hands plain rows to these helpers.
 */

export interface PersonContactRow {
  id: string;
  channelType: string;
  channelName: string | null;
  name: string | null;
  phone: string | null;
  language: string | null;
  consentStatus: 'UNKNOWN' | 'GRANTED' | 'REVOKED';
  marketingOptOut: boolean;
  createdAt: Date;
}

export interface ContactActivity {
  conversationCount: number;
  leadCount: number;
  /** Newest conversation of the contact, if any. */
  last: { id: string; updatedAt: Date } | null;
}

export interface PersonItem {
  id: string;
  displayName: string | null;
  phone: string | null;
  channels: Array<{ contactId: string; channelType: string }>;
  conversationCount: number;
  leadCount: number;
  lastConversationId: string | null;
  lastActivityAt: string | null;
  marketingOptOut: boolean;
  createdAt: string;
  /** Active tags (ADR 053), by name. */
  tags: Array<{ id: string; name: string; color: string | null }>;
}

export interface PersonDetail extends PersonItem {
  /** Active custom field definitions with this person's values (ADR 053). */
  customFields: Array<{
    key: string;
    label: string;
    type: 'TEXT' | 'NUMBER' | 'DATE' | 'BOOLEAN' | 'SELECT';
    value: string | number | boolean | null;
  }>;
  /** Latest un-undone merge into this person, while it can be undone. */
  lastMerge: { id: string; mergedAt: string; contacts: number } | null;
  contacts: Array<{
    id: string;
    channelType: string;
    channelName: string | null;
    name: string | null;
    phone: string | null;
    language: string | null;
    consentStatus: 'UNKNOWN' | 'GRANTED' | 'REVOKED';
    marketingOptOut: boolean;
    createdAt: string;
  }>;
  conversations: Array<{
    id: string;
    contactId: string;
    channelType: string;
    state: 'BOT_ACTIVE' | 'WAITING_OPERATOR' | 'OPERATOR_ACTIVE' | 'CLOSED';
    updatedAt: string;
  }>;
  leads: Array<{
    id: string;
    contactId: string;
    status: 'NEW' | 'IN_PROGRESS' | 'WON' | 'LOST';
    score: 'HOT' | 'WARM' | 'COLD';
    stageName: string | null;
    updatedAt: string;
  }>;
}

/** Oldest first, ties broken by id, so the order is stable. */
export function sortContactsOldestFirst<
  T extends { id: string; createdAt: Date },
>(contacts: T[]): T[] {
  return [...contacts].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Builds the list item of one person from its NON-ERASED contacts and the
 * per-contact activity numbers.
 */
export function assemblePersonItem(
  person: { id: string; displayName: string | null; createdAt: Date },
  contactsInput: PersonContactRow[],
  activity: ReadonlyMap<string, ContactActivity>,
  tags: PersonItem['tags'] = [],
): PersonItem {
  const contacts = sortContactsOldestFirst(contactsInput);
  let conversationCount = 0;
  let leadCount = 0;
  let last: { id: string; updatedAt: Date } | null = null;
  for (const contact of contacts) {
    const a = activity.get(contact.id);
    if (!a) continue;
    conversationCount += a.conversationCount;
    leadCount += a.leadCount;
    if (
      a.last &&
      (!last ||
        a.last.updatedAt.getTime() > last.updatedAt.getTime() ||
        (a.last.updatedAt.getTime() === last.updatedAt.getTime() &&
          a.last.id > last.id))
    )
      last = a.last;
  }
  return {
    id: person.id,
    // The person's own name wins; the channel name often arrives later (the
    // Instagram name is filled after intake), so fall back to the oldest
    // contact that has one instead of showing a named customer as unnamed.
    displayName:
      person.displayName ?? contacts.find((c) => c.name !== null)?.name ?? null,
    phone: contacts.find((c) => c.phone !== null)?.phone ?? null,
    channels: contacts.map((c) => ({
      contactId: c.id,
      channelType: c.channelType,
    })),
    conversationCount,
    leadCount,
    lastConversationId: last?.id ?? null,
    lastActivityAt: last ? last.updatedAt.toISOString() : null,
    marketingOptOut: contacts.some((c) => c.marketingOptOut),
    createdAt: person.createdAt.toISOString(),
    tags,
  };
}
