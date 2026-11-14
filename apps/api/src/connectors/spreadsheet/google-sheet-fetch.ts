import { SHEET_LIMITS } from './csv-reader.js';
import {
  GOOGLE_SHEETS_HOST,
  type GoogleSheetRef,
} from './google-sheet-link.js';

export type SheetFetchErrorCode =
  | 'SHEET_LINK_INVALID'
  | 'SHEET_LINK_NOT_PUBLIC'
  | 'SHEET_LINK_UNREACHABLE'
  | 'SHEET_LINK_NOT_A_SHEET'
  | 'SHEET_TOO_LARGE';

export class SheetFetchError extends Error {
  constructor(
    readonly code: SheetFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SheetFetchError';
  }
}

export interface SheetFetchOptions {
  /** The origin the export is read from; Google's, or a fake in the e2e. */
  readonly origin?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxBytes?: number;
}

const DEFAULT_ORIGIN = `https://${GOOGLE_SHEETS_HOST}`;

/** Hosts a redirect may lead to: Google's sheet host and its content hosts. */
function allowedHost(host: string, originHost: string): boolean {
  return (
    host === originHost ||
    (originHost === GOOGLE_SHEETS_HOST &&
      (host === 'googleusercontent.com' ||
        host.endsWith('.googleusercontent.com')))
  );
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes)
    throw new SheetFetchError('SHEET_TOO_LARGE', 'The sheet is too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SheetFetchError('SHEET_TOO_LARGE', 'The sheet is too large');
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/**
 * Reads the CSV of a shared Google sheet. Redirects are followed by hand
 * (https only, at most three hops, only to Google's hosts), the body is read
 * with a size cap, and a login page or any other HTML is "not public": a
 * private sheet answers with Google's sign-in page, not with an error code.
 */
export async function fetchSheetCsv(
  ref: GoogleSheetRef,
  options: SheetFetchOptions = {},
): Promise<string> {
  const origin = new URL(options.origin ?? DEFAULT_ORIGIN);
  const doFetch = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? SHEET_LIMITS.maxBytes;
  const maxRedirects = options.maxRedirects ?? 3;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  let url = new URL(`${ref.exportPath}?${ref.exportQuery}`, origin);

  for (let hop = 0; ; hop += 1) {
    if (
      (origin.protocol === 'https:' && url.protocol !== 'https:') ||
      !allowedHost(url.hostname, origin.hostname)
    )
      throw new SheetFetchError(
        'SHEET_LINK_NOT_PUBLIC',
        'The sheet is not shared by link',
      );
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          accept: 'text/csv,text/plain;q=0.9',
          'user-agent': 'tezda-price-list',
        },
      });
    } catch {
      throw new SheetFetchError(
        'SHEET_LINK_UNREACHABLE',
        'Google did not answer',
      );
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || hop >= maxRedirects)
        throw new SheetFetchError(
          'SHEET_LINK_UNREACHABLE',
          'Too many redirects',
        );
      url = new URL(location, url);
      continue;
    }
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404
    )
      throw new SheetFetchError(
        'SHEET_LINK_NOT_PUBLIC',
        'The sheet is not shared by link',
      );
    if (!response.ok)
      throw new SheetFetchError(
        'SHEET_LINK_UNREACHABLE',
        'Google did not answer',
      );
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (type.includes('text/html'))
      throw new SheetFetchError(
        'SHEET_LINK_NOT_PUBLIC',
        'The sheet is not shared by link',
      );
    if (
      !type.includes('text/csv') &&
      !type.includes('text/plain') &&
      type !== ''
    )
      throw new SheetFetchError(
        'SHEET_LINK_NOT_A_SHEET',
        'The link is not a sheet',
      );
    return readCapped(response, maxBytes);
  }
}
