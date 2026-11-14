/**
 * A Google Sheets link as a price list source (ADR 064 S3): only a sheet that
 * its owner shared as "anyone with the link can view" (or published to the
 * web) can be read; no Google account is involved. Pure URL handling first:
 * the export address is BUILT from the sheet id, never taken from the pasted
 * text, so the server can only ever ask Google's own export endpoint.
 */

export const GOOGLE_SHEETS_HOST = 'docs.google.com';

export interface GoogleSheetRef {
  /** The link, normalised: the same sheet and tab always give the same text. */
  readonly canonicalUrl: string;
  /** Where the CSV is read from (`/export?format=csv` or the published `/pub` address). */
  readonly exportPath: string;
  readonly exportQuery: string;
}

const ID = /^[A-Za-z0-9_-]{20,120}$/u;
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/u;

function gidOf(url: URL): string | null {
  const fromHash = /(?:^|[&#])gid=(\d{1,12})(?:$|&)/u.exec(url.hash.slice(1));
  const fromQuery = url.searchParams.get('gid');
  const value = fromQuery ?? (fromHash ? fromHash[1] : null);
  return value !== null && /^\d{1,12}$/u.test(value) ? value : null;
}

/** `null` when the text is not a Google Sheets link we can read. */
export function parseGoogleSheetLink(text: string): GoogleSheetRef | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== GOOGLE_SHEETS_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  )
    return null;
  const gid = gidOf(url);

  // Published to the web: /spreadsheets/d/e/<token>/pub?...
  const published = /^\/spreadsheets\/d\/e\/([^/]+)\/pub$/u.exec(url.pathname);
  if (published) {
    const token = published[1]!;
    if (!TOKEN.test(token)) return null;
    const query = `${gid ? `gid=${gid}&` : ''}single=true&output=csv`;
    return {
      canonicalUrl: `https://${GOOGLE_SHEETS_HOST}/spreadsheets/d/e/${token}/pub?${query}`,
      exportPath: `/spreadsheets/d/e/${token}/pub`,
      exportQuery: query,
    };
  }

  // Shared by link: /spreadsheets/d/<id>/edit, /view, /htmlview, /export ...
  const shared = /^\/spreadsheets\/d\/([^/]+)(?:\/[a-z]*)?$/u.exec(
    url.pathname,
  );
  if (!shared) return null;
  const id = shared[1]!;
  if (!ID.test(id)) return null;
  return {
    canonicalUrl: `https://${GOOGLE_SHEETS_HOST}/spreadsheets/d/${id}/edit${gid ? `#gid=${gid}` : ''}`,
    exportPath: `/spreadsheets/d/${id}/export`,
    exportQuery: `format=csv${gid ? `&gid=${gid}` : ''}`,
  };
}
