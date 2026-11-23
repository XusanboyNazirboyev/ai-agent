/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { describe, expect, it } from 'vitest';
import {
  OnlinePbxClient,
  parseOnlinePbxDomain,
  type OnlinePbxTransport,
} from './onlinepbx-client.js';

interface Sent {
  url: string;
  form: Record<string, string>;
  headers: Record<string, string>;
}

/** Answers each request with the next scripted body (status 200 unless given). */
function scripted(replies: Array<unknown | { http: number; body?: unknown }>) {
  const sent: Sent[] = [];
  const transport: OnlinePbxTransport = async (url, form, headers) => {
    sent.push({ url, form: { ...form }, headers: { ...headers } });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    if (next && typeof next === 'object' && 'http' in next)
      return {
        status: next.http as number,
        body: (next as { body?: unknown }).body,
      };
    return { status: 200, body: next };
  };
  return { sent, transport };
}

const AUTH_OK = { status: '1', data: { key_id: 'kid', key: 'secret' } };
const client = (transport: OnlinePbxTransport) =>
  new OnlinePbxClient({
    domain: 'example.onpbx.ru',
    apiKey: 'api-key',
    transport,
  });

describe('parseOnlinePbxDomain', () => {
  it('takes a bare domain and refuses anything that is not one', () => {
    expect(parseOnlinePbxDomain(' Example.onpbx.ru ')).toBe('example.onpbx.ru');
    for (const bad of [
      '',
      'onpbx',
      'a/b.ru',
      'https://x.onpbx.ru',
      '../x.ru',
      'x..ru',
    ])
      expect(parseOnlinePbxDomain(bad)).toBeUndefined();
  });
});

describe('OnlinePbxClient', () => {
  it('authenticates with the API key and sends the session on later calls', async () => {
    const { sent, transport } = scripted([AUTH_OK, { status: '1', data: [] }]);
    const pbx = client(transport);
    await pbx.answeredCalls(1_700_000_000, 1_700_000_600);
    expect(sent[0]).toEqual({
      url: 'https://api2.onlinepbx.ru/example.onpbx.ru/auth.json',
      form: { auth_key: 'api-key' },
      headers: {},
    });
    expect(sent[1]).toEqual({
      url: 'https://api2.onlinepbx.ru/example.onpbx.ru/mongo_history/search.json',
      form: {
        end_stamp_from: '1700000000',
        end_stamp_to: '1700000600',
        user_talk_time_from: '1',
      },
      headers: { 'x-pbx-authentication': 'kid:secret' },
    });
    expect(pbx.session).toEqual({ keyId: 'kid', key: 'secret' });
  });

  it('reports a refused key as REJECTED', async () => {
    const { transport } = scripted([{ status: '0', comment: 'bad key' }]);
    await expect(client(transport).authenticate()).rejects.toMatchObject({
      code: 'REJECTED',
    });
  });

  it('reads answered calls and skips rows that are not finished', async () => {
    const { transport } = scripted([
      AUTH_OK,
      {
        status: '1',
        data: [
          {
            uuid: 'c1',
            caller_id_number: 998901234567,
            destination_number: '100',
            start_stamp: 1700000000,
            end_stamp: '1700000090',
            user_talk_time: 75,
            accountcode: 'inbound',
          },
          {
            uuid: 'c2',
            caller_id_number: '1',
            destination_number: '2',
            start_stamp: '',
            end_stamp: '',
            user_talk_time: 0,
          },
          { nonsense: true },
        ],
      },
    ]);
    expect(
      await client(transport).answeredCalls(1_700_000_000, 1_700_000_100),
    ).toEqual([
      {
        uuid: 'c1',
        callerNumber: '998901234567',
        destinationNumber: '100',
        direction: 'inbound',
        startedAt: new Date(1_700_000_000_000),
        endedAt: new Date(1_700_000_090_000),
        talkSeconds: 75,
      },
    ]);
  });

  it('refuses a window longer than the API allows', async () => {
    const { sent, transport } = scripted([]);
    await expect(
      client(transport).answeredCalls(0, 8 * 24 * 3600),
    ).rejects.toThrow(RangeError);
    expect(sent).toEqual([]);
  });

  it('re-authenticates once when the session expired, then gives up', async () => {
    const expired = { status: '0', isNotAuth: true };
    const ok = scripted([
      AUTH_OK,
      expired,
      { status: '1', data: { key_id: 'k2', key: 's2' } },
      { status: '1', data: [] },
    ]);
    const pbx = client(ok.transport);
    await expect(pbx.answeredCalls(0, 60)).resolves.toEqual([]);
    expect(ok.sent.at(-1)?.headers).toEqual({
      'x-pbx-authentication': 'k2:s2',
    });

    const bad = scripted([AUTH_OK, expired, AUTH_OK, expired]);
    await expect(
      client(bad.transport).answeredCalls(0, 60),
    ).rejects.toMatchObject({ code: 'REJECTED' });
    expect(bad.sent).toHaveLength(4);
  });

  it('accepts a recording link only on the documented download path', async () => {
    const link = 'https://api2.onlinepbx.ru/calls-records/download/abc/rec.mp3';
    const good = scripted([AUTH_OK, { status: '1', data: link }]);
    expect(await client(good.transport).recordingUrl('c1')).toBe(link);
    expect(good.sent[1]?.form).toEqual({ uuid: 'c1', download: '1' });

    const foreign = scripted([
      AUTH_OK,
      { status: '1', data: 'https://169.254.169.254/latest' },
    ]);
    await expect(
      client(foreign.transport).recordingUrl('c1'),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('maps network failures, 5xx and non-JSON bodies to codes without provider text', async () => {
    await expect(
      client(scripted([new Error('ECONNRESET')]).transport).authenticate(),
    ).rejects.toMatchObject({ code: 'UNREACHABLE' });
    await expect(
      client(scripted([{ http: 502 }]).transport).authenticate(),
    ).rejects.toMatchObject({ code: 'UNREACHABLE' });
    await expect(
      client(
        scripted([{ http: 200, body: undefined }]).transport,
      ).authenticate(),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});
