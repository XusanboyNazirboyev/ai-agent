import { z } from 'zod';

/**
 * OnlinePBX HTTP API v2 client (ADR 085). Only what call analysis needs:
 * auth, answered calls by end time, a call's recording link. Read from the
 * official OpenAPI spec https://api.onlinepbx.ru/api-scheme.yaml (v2.10.1,
 * 2026-11-23). Requests are form-encoded POSTs to `{base}/{domain}/…`; the
 * session key from `auth.json` goes in `x-pbx-authentication: key_id:key`.
 */
export const ONLINEPBX_API_BASE = 'https://api2.onlinepbx.ru';
/** The spec's own limit for one search request (end_stamp window). */
export const ONLINEPBX_MAX_WINDOW_SECONDS = 7 * 24 * 3600;
// shortcut: only the host the spec documents; widen if a real account serves records elsewhere.
const RECORDING_PREFIX = `${ONLINEPBX_API_BASE}/calls-records/download/`;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN = new RegExp(`^(?=.{4,253}$)${LABEL}(?:\\.${LABEL})+$`, 'u');

/** The tenant's PBX domain ("example.onpbx.ru"); a path segment, never a host we call. */
export function parseOnlinePbxDomain(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  return DOMAIN.test(value) ? value : undefined;
}

/** Test seam for every OnlinePBX call (a fake PBX in tests). */
export const ONLINEPBX_TRANSPORT = Symbol('ONLINEPBX_TRANSPORT');

export type OnlinePbxTransport = (
  url: string,
  form: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>>,
) => Promise<{ status: number; body: unknown }>;

export type OnlinePbxErrorCode = 'UNREACHABLE' | 'REJECTED' | 'BAD_RESPONSE';

/** Never carries the key or the provider's text, only a code. */
export class OnlinePbxError extends Error {
  constructor(readonly code: OnlinePbxErrorCode) {
    super(`OnlinePBX request failed: ${code}`);
    this.name = 'OnlinePbxError';
  }
}

export interface OnlinePbxSession {
  readonly keyId: string;
  readonly key: string;
}

export interface OnlinePbxCall {
  readonly uuid: string;
  readonly callerNumber: string;
  readonly destinationNumber: string;
  /** `accountcode` as given: inbound, outbound, local, … ('' when absent). */
  readonly direction: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly talkSeconds: number;
}

const Envelope = z.object({
  status: z.union([z.string(), z.number()]).transform(String),
  isNotAuth: z.boolean().optional(),
  data: z.unknown().optional(),
});
const AuthData = z.object({
  key_id: z.string().min(1).max(200),
  key: z.string().min(1).max(500),
});
const Stamp = z.union([z.number().int(), z.string().regex(/^\d{10}$/u)]);
const CallRow = z.object({
  uuid: z.string().min(1).max(100),
  caller_id_number: z.union([z.string(), z.number()]).transform(String),
  destination_number: z.union([z.string(), z.number()]).transform(String),
  start_stamp: z.union([Stamp, z.literal('')]),
  end_stamp: z.union([Stamp, z.literal('')]),
  user_talk_time: z.coerce.number().int().min(0),
  accountcode: z.string().optional(),
});

const at = (stamp: number | string): Date => new Date(Number(stamp) * 1000);

export const fetchOnlinePbxTransport: OnlinePbxTransport = async (
  url,
  form,
  headers,
) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(form).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
};

export interface OnlinePbxClientOptions {
  readonly domain: string;
  readonly apiKey: string;
  readonly transport?: OnlinePbxTransport;
  /** A session from an earlier client; re-authenticated only when refused. */
  readonly session?: OnlinePbxSession;
}

export class OnlinePbxClient {
  private readonly transport: OnlinePbxTransport;
  private current: OnlinePbxSession | undefined;

  constructor(private readonly options: OnlinePbxClientOptions) {
    this.transport = options.transport ?? fetchOnlinePbxTransport;
    this.current = options.session;
  }

  /** The session in use, to reuse later (the spec: frequent re-auth breaks sessions). */
  get session(): OnlinePbxSession | undefined {
    return this.current;
  }

  /** Checks the API key and starts a session; REJECTED means a wrong key or domain. */
  async authenticate(): Promise<OnlinePbxSession> {
    const envelope = await this.post('auth.json', {
      auth_key: this.options.apiKey,
    });
    const data = AuthData.safeParse(envelope.data);
    if (envelope.status !== '1' || !data.success)
      throw new OnlinePbxError('REJECTED');
    this.current = { keyId: data.data.key_id, key: data.data.key };
    return this.current;
  }

  /** Answered calls that ended in [fromSec, toSec] (Unix seconds, at most one week). */
  async answeredCalls(
    fromSec: number,
    toSec: number,
  ): Promise<OnlinePbxCall[]> {
    if (toSec < fromSec || toSec - fromSec > ONLINEPBX_MAX_WINDOW_SECONDS)
      throw new RangeError('OnlinePBX search window must be 0 to 7 days');
    const data = await this.authed('mongo_history/search.json', {
      end_stamp_from: String(fromSec),
      end_stamp_to: String(toSec),
      user_talk_time_from: '1',
    });
    if (!Array.isArray(data)) throw new OnlinePbxError('BAD_RESPONSE');
    const calls: OnlinePbxCall[] = [];
    for (const raw of data) {
      const row = CallRow.safeParse(raw);
      // A row without both stamps is not a finished call; skip it, keep the rest.
      if (
        !row.success ||
        row.data.start_stamp === '' ||
        row.data.end_stamp === ''
      )
        continue;
      calls.push({
        uuid: row.data.uuid,
        callerNumber: row.data.caller_id_number,
        destinationNumber: row.data.destination_number,
        direction: row.data.accountcode ?? '',
        startedAt: at(row.data.start_stamp),
        endedAt: at(row.data.end_stamp),
        talkSeconds: row.data.user_talk_time,
      });
    }
    return calls;
  }

  /** A temporary download link for the call's recording. */
  async recordingUrl(uuid: string): Promise<string> {
    const data = await this.authed('mongo_history/search.json', {
      uuid,
      download: '1',
    });
    if (typeof data !== 'string' || !data.startsWith(RECORDING_PREFIX))
      throw new OnlinePbxError('BAD_RESPONSE');
    return data;
  }

  /** One request with the session; on `isNotAuth` authenticates once and retries. */
  private async authed(
    path: string,
    form: Record<string, string>,
  ): Promise<unknown> {
    const session = this.current ?? (await this.authenticate());
    let envelope = await this.post(path, form, session);
    if (envelope.isNotAuth === true) {
      envelope = await this.post(path, form, await this.authenticate());
      if (envelope.isNotAuth === true) throw new OnlinePbxError('REJECTED');
    }
    if (envelope.status !== '1') throw new OnlinePbxError('REJECTED');
    return envelope.data;
  }

  private async post(
    path: string,
    form: Record<string, string>,
    session?: OnlinePbxSession,
  ): Promise<z.infer<typeof Envelope>> {
    let response: { status: number; body: unknown };
    try {
      response = await this.transport(
        `${ONLINEPBX_API_BASE}/${this.options.domain}/${path}`,
        form,
        session
          ? { 'x-pbx-authentication': `${session.keyId}:${session.key}` }
          : {},
      );
    } catch {
      throw new OnlinePbxError('UNREACHABLE');
    }
    if (response.status >= 500) throw new OnlinePbxError('UNREACHABLE');
    const envelope = Envelope.safeParse(response.body);
    if (!envelope.success) throw new OnlinePbxError('BAD_RESPONSE');
    return envelope.data;
  }
}
