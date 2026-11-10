import type { Dispatcher } from 'undici';
import {
  createPinnedDispatcher,
  type HostResolver,
  releaseDispatcher,
  resolvePinnedAddresses,
} from '../../connectors/generic-rest/dns-pinning.js';
import {
  OutboundUrlPolicy,
  validateOutboundUrl,
} from '../../connectors/generic-rest/ssrf-protection.js';

/**
 * Downloads a customer's media from a URL that arrived in a webhook
 * (Instagram voice notes, ADR 042). The URL is untrusted input: the webhook
 * signature proves Meta sent it, not that it is safe to fetch. So the
 * download is:
 * - https on the default port only, no embedded credentials, no restricted
 *   hostname or IP literal (STRICT outbound policy);
 * - DNS-pinned: the host is resolved once, every answer must be a public
 *   address, and the socket can only connect to those (no rebinding);
 * - never redirected (a 3xx is a failure) and never authenticated: no token
 *   or cookie of ours is sent to a host named by the customer's message;
 * - bounded: the declared length and the bytes that actually arrive are both
 *   capped, and a deadline covers resolution, headers and body.
 * Nothing about the URL or the body is logged or returned on failure.
 */
export type MediaDownload =
  | {
      readonly ok: true;
      readonly data: Uint8Array;
      /** The response media type without parameters, lower case, if sent. */
      readonly contentType: string | null;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'INVALID_URL'
        | 'BLOCKED'
        | 'HTTP_ERROR'
        | 'TOO_LARGE'
        | 'TIMEOUT'
        | 'NETWORK';
    };

export interface MediaDownloadOptions {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  /** Tests: replaces the DNS lookup. */
  readonly resolve?: HostResolver;
  /** Tests: replaces the pinned undici dispatcher. */
  readonly createDispatcher?: () => Dispatcher;
}

export async function downloadPublicMedia(
  rawUrl: string,
  options: MediaDownloadOptions,
): Promise<MediaDownload> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, code: 'INVALID_URL' };
  }
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443'))
    return { ok: false, code: 'INVALID_URL' };
  try {
    validateOutboundUrl(url.href, { policy: OutboundUrlPolicy.STRICT });
  } catch {
    return { ok: false, code: 'BLOCKED' };
  }

  const deadline = AbortSignal.timeout(options.timeoutMs);
  let dispatcher: Dispatcher | undefined;
  let graceful = false;
  try {
    const addresses = await resolvePinnedAddresses(url.hostname, {
      policy: OutboundUrlPolicy.STRICT,
      ...(options.resolve ? { resolve: options.resolve } : {}),
    });
    dispatcher =
      options.createDispatcher?.() ??
      createPinnedDispatcher(addresses, {
        connectTimeoutMs: options.timeoutMs,
        headersTimeoutMs: options.timeoutMs,
        bodyTimeoutMs: options.timeoutMs,
        maxResponseBytes: options.maxBytes,
      });
    const response = await dispatcher.request({
      origin: url.origin,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { accept: 'audio/*,video/*;q=0.5,*/*;q=0.1' },
      signal: deadline,
    });

    const header = (name: string): string | undefined => {
      const value = response.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    if (response.statusCode < 200 || response.statusCode >= 300) {
      await response.body.dump({ limit: 4_096, signal: deadline });
      graceful = true;
      return { ok: false, code: 'HTTP_ERROR' };
    }
    const declared = Number(header('content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes)
      return { ok: false, code: 'TOO_LARGE' };

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > options.maxBytes) return { ok: false, code: 'TOO_LARGE' };
      chunks.push(chunk);
    }
    graceful = true;
    if (total === 0) return { ok: false, code: 'HTTP_ERROR' };
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const type = header('content-type')?.split(';')[0]?.trim().toLowerCase();
    return { ok: true, data, contentType: type ? type : null };
  } catch (error: unknown) {
    if (deadline.aborted) return { ok: false, code: 'TIMEOUT' };
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'UND_ERR_RESPONSE_EXCEEDED_MAX_SIZE')
      return { ok: false, code: 'TOO_LARGE' };
    // A restricted resolution is a refusal, any other failure a network one.
    return {
      ok: false,
      code: /SSRF|restricted|blocked/iu.test(
        String((error as { code?: unknown; message?: unknown } | null)?.code) +
          String((error as { message?: unknown } | null)?.message),
      )
        ? 'BLOCKED'
        : 'NETWORK',
    };
  } finally {
    if (dispatcher) await releaseDispatcher(dispatcher, { graceful });
  }
}
