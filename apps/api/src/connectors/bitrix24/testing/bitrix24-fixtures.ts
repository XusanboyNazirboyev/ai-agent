/**
 * Bitrix24 response shapes for CI, no network.
 *
 * RECORDED: from the owner's test portal on 2026-10-27 with synthetic data
 * (scripts/bitrix24-probe.ts), then scrubbed: portal-specific IDs and
 * timestamps replaced, only the keys the connector reads kept, no URL, host
 * or webhook code. DOCS: error bodies taken from
 * https://apidocs.bitrix24.com/limits.html (read 2026-10-27), not recorded.
 * `bitrix24-fixtures.spec.ts` fails if anything here looks like a real
 * webhook path or a non-synthetic phone number.
 */

/** RECORDED crm.settings.mode.get (1 = classic CRM with leads). */
export const MODE_CLASSIC = {
  result: 1,
  time: { operating_reset_at: 1_793_000_000 },
};

/** RECORDED crm.item.add (lead), trimmed to the keys the connector reads. */
export function itemAddResponse(
  id: number,
  fields: Record<string, unknown>,
): {
  result: { item: Record<string, unknown> };
  time: { operating_reset_at: number };
} {
  return {
    result: {
      item: {
        id,
        title: fields.title ?? null,
        sourceId: fields.sourceId ?? null,
        originatorId: fields.originatorId ?? null,
        originId: fields.originId ?? null,
        contactId: fields.contactId ?? null,
        fm: Array.isArray(fields.fm)
          ? (fields.fm as Array<Record<string, unknown>>).map(
              (entry, index) => ({
                id: 100 + index,
                ...entry,
              }),
            )
          : [],
      },
    },
    time: { operating_reset_at: 1_793_000_000 },
  };
}

/** RECORDED crm.item.list: the selected fields of each matching item. */
export function itemListResponse(
  items: ReadonlyArray<Record<string, unknown>>,
): {
  result: { items: Array<Record<string, unknown>> };
  total: number;
} {
  return { result: { items: [...items] }, total: items.length };
}

/** RECORDED crm.duplicate.findbycomm: IDs per entity type only. */
export const DUPLICATE_LEAD = { result: { LEAD: [2] } };
/** DOCS shape for a contact match (the probe portal had only a lead). */
export const DUPLICATE_CONTACT = { result: { CONTACT: [4] } };
/** RECORDED: no match comes back as an empty list, not an object. */
export const DUPLICATE_NONE = { result: [] };

/** RECORDED crm.timeline.comment.add: the comment ID. */
export const COMMENT_ADDED = { result: 6 };

/** DOCS: request limit exceeded (HTTP 503). */
export const QUERY_LIMIT_EXCEEDED = {
  error: 'QUERY_LIMIT_EXCEEDED',
  error_description: 'Too many requests',
};
/** DOCS: method operating time exceeded (HTTP 429). */
export const OPERATION_TIME_LIMIT = {
  error: 'OPERATION_TIME_LIMIT',
  error_description: 'Method is blocked due to operation time limit.',
};
/** DOCS: bad webhook code (HTTP 401). */
export const INVALID_CREDENTIALS = {
  error: 'INVALID_CREDENTIALS',
  error_description: 'Invalid request credentials',
};

/** Synthetic webhook URL used by every test (no real portal). */
export const TEST_WEBHOOK_URL =
  'https://portal.example.test/rest/1/REDACTED0000test/';
