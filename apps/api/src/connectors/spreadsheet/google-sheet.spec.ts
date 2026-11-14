import { describe, expect, it } from 'vitest';
import { fetchSheetCsv, SheetFetchError } from './google-sheet-fetch.js';
import { parseGoogleSheetLink } from './google-sheet-link.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-aBcDe';

describe('Google Sheets link', () => {
  it('reads shared links of every usual shape and builds the export address itself', () => {
    const edit = parseGoogleSheetLink(
      `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=1234`,
    );
    expect(edit).toEqual({
      canonicalUrl: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=1234`,
      exportPath: `/spreadsheets/d/${ID}/export`,
      exportQuery: 'format=csv&gid=1234',
    });
    const withQuery = parseGoogleSheetLink(
      `  https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing&gid=7  `,
    );
    expect(withQuery?.exportQuery).toBe('format=csv&gid=7');
    // No tab named: the first tab.
    expect(
      parseGoogleSheetLink(`https://docs.google.com/spreadsheets/d/${ID}/view`)
        ?.exportQuery,
    ).toBe('format=csv');
    expect(
      parseGoogleSheetLink(`https://docs.google.com/spreadsheets/d/${ID}`)
        ?.exportQuery,
    ).toBe('format=csv');
  });

  it('reads a sheet published to the web', () => {
    const token = '2PACX-1vQabcdefghijklmnopqrstuvwxyz0123456789';
    expect(
      parseGoogleSheetLink(
        `https://docs.google.com/spreadsheets/d/e/${token}/pub?gid=5&single=true&output=csv`,
      ),
    ).toMatchObject({
      exportPath: `/spreadsheets/d/e/${token}/pub`,
      exportQuery: 'gid=5&single=true&output=csv',
    });
  });

  it('refuses anything that is not a plain https Google Sheets link', () => {
    const bad = [
      '',
      'not a link',
      `http://docs.google.com/spreadsheets/d/${ID}/edit`,
      `https://docs.google.com.evil.test/spreadsheets/d/${ID}/edit`,
      `https://evil.test/spreadsheets/d/${ID}/edit`,
      `https://user:pass@docs.google.com/spreadsheets/d/${ID}/edit`,
      `https://docs.google.com:8443/spreadsheets/d/${ID}/edit`,
      `https://drive.google.com/spreadsheets/d/${ID}/edit`,
      `https://docs.google.com/document/d/${ID}/edit`,
      'https://docs.google.com/spreadsheets/d/short/edit',
      `https://docs.google.com/spreadsheets/d/${ID}/../../etc/passwd`,
      `https://docs.google.com/spreadsheets/d/${ID}/edit/extra`,
      `https://docs.google.com/spreadsheets/d/${'a'.repeat(200)}/edit`,
      `javascript:alert(1)//docs.google.com/spreadsheets/d/${ID}/edit`,
    ];
    for (const text of bad) expect(parseGoogleSheetLink(text), text).toBeNull();
  });

  it('keeps only digits as the tab id and never copies other query values', () => {
    const ref = parseGoogleSheetLink(
      `https://docs.google.com/spreadsheets/d/${ID}/edit?gid=12abc&x=http://127.0.0.1/`,
    );
    expect(ref?.exportQuery).toBe('format=csv');
    expect(ref?.canonicalUrl).not.toContain('127.0.0.1');
  });
});

const REF = parseGoogleSheetLink(
  `https://docs.google.com/spreadsheets/d/${ID}/edit`,
)!;

function reply(
  body: string,
  init: {
    status?: number;
    type?: string;
    headers?: Record<string, string>;
  } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      'content-type': init.type ?? 'text/csv; charset=utf-8',
      ...init.headers,
    },
  });
}

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return 'no error';
  } catch (error) {
    return error instanceof SheetFetchError
      ? error.code
      : `other:${String(error)}`;
  }
};

describe('fetching the CSV of a shared sheet', () => {
  it('asks only Google’s export address and returns the text', async () => {
    const seen: string[] = [];
    const text = await fetchSheetCsv(REF, {
      fetchImpl: async (input) => {
        seen.push(String(input));
        return reply('Hotel,Price\nA,100\n');
      },
    });
    expect(text).toBe('Hotel,Price\nA,100\n');
    expect(seen).toEqual([
      `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv`,
    ]);
  });

  it('follows Google’s own redirect to its content host and no other', async () => {
    const hops: string[] = [];
    const ok = await fetchSheetCsv(REF, {
      fetchImpl: async (input) => {
        hops.push(String(input));
        return hops.length === 1
          ? new Response(null, {
              status: 307,
              headers: {
                location:
                  'https://doc-0k-aa-sheets.googleusercontent.com/export/x?y=1',
              },
            })
          : reply('a,b\n1,2');
      },
    });
    expect(ok).toBe('a,b\n1,2');
    expect(hops[1]).toBe(
      'https://doc-0k-aa-sheets.googleusercontent.com/export/x?y=1',
    );

    for (const location of [
      'https://evil.test/steal',
      'http://docs.google.com/x',
      'https://127.0.0.1/admin',
      'https://googleusercontent.com.evil.test/x',
      'https://accounts.google.com/ServiceLogin',
    ])
      expect(
        await codeOf(
          fetchSheetCsv(REF, {
            fetchImpl: async () =>
              new Response(null, { status: 302, headers: { location } }),
          }),
        ),
        location,
      ).toBe('SHEET_LINK_NOT_PUBLIC');
  });

  it('stops a redirect loop', async () => {
    let calls = 0;
    expect(
      await codeOf(
        fetchSheetCsv(REF, {
          fetchImpl: async () => {
            calls += 1;
            return new Response(null, {
              status: 302,
              headers: { location: `https://docs.google.com/loop/${calls}` },
            });
          },
        }),
      ),
    ).toBe('SHEET_LINK_UNREACHABLE');
    expect(calls).toBe(4);
  });

  it('calls a private sheet "not public": Google answers with its sign-in page', async () => {
    expect(
      await codeOf(
        fetchSheetCsv(REF, {
          fetchImpl: async () =>
            reply('<html>Sign in</html>', { type: 'text/html; charset=utf-8' }),
        }),
      ),
    ).toBe('SHEET_LINK_NOT_PUBLIC');
    for (const status of [401, 403, 404])
      expect(
        await codeOf(
          fetchSheetCsv(REF, { fetchImpl: async () => reply('', { status }) }),
        ),
        String(status),
      ).toBe('SHEET_LINK_NOT_PUBLIC');
  });

  it('reports an unreachable Google and a link that is not a sheet', async () => {
    expect(
      await codeOf(
        fetchSheetCsv(REF, {
          fetchImpl: async () => reply('', { status: 500 }),
        }),
      ),
    ).toBe('SHEET_LINK_UNREACHABLE');
    expect(
      await codeOf(
        fetchSheetCsv(REF, {
          fetchImpl: async () => {
            throw new Error('network down');
          },
        }),
      ),
    ).toBe('SHEET_LINK_UNREACHABLE');
    expect(
      await codeOf(
        fetchSheetCsv(REF, {
          fetchImpl: async () => reply('%PDF', { type: 'application/pdf' }),
        }),
      ),
    ).toBe('SHEET_LINK_NOT_A_SHEET');
  });

  it('refuses a body over the size cap, declared or streamed', async () => {
    expect(
      await codeOf(
        fetchSheetCsv(REF, {
          maxBytes: 100,
          fetchImpl: async () =>
            reply('x'.repeat(500), { headers: { 'content-length': '500' } }),
        }),
      ),
    ).toBe('SHEET_TOO_LARGE');
    // No length declared: the stream is cut when it passes the cap.
    expect(
      await codeOf(
        fetchSheetCsv(REF, {
          maxBytes: 100,
          fetchImpl: async () =>
            new Response(
              new ReadableStream({
                start(controller): void {
                  for (let i = 0; i < 10; i += 1)
                    controller.enqueue(
                      new TextEncoder().encode('x'.repeat(50)),
                    );
                  controller.close();
                },
              }),
              { status: 200, headers: { 'content-type': 'text/csv' } },
            ),
        }),
      ),
    ).toBe('SHEET_TOO_LARGE');
  });

  it('reads from a fake origin (the e2e), and then only that host', async () => {
    const seen: string[] = [];
    const text = await fetchSheetCsv(REF, {
      origin: 'http://127.0.0.1:4024',
      fetchImpl: async (input) => {
        seen.push(String(input));
        return reply('ok,1');
      },
    });
    expect(text).toBe('ok,1');
    expect(seen[0]).toBe(
      `http://127.0.0.1:4024/spreadsheets/d/${ID}/export?format=csv`,
    );
    expect(
      await codeOf(
        fetchSheetCsv(REF, {
          origin: 'http://127.0.0.1:4024',
          fetchImpl: async () =>
            new Response(null, {
              status: 302,
              headers: { location: 'http://10.0.0.1/x' },
            }),
        }),
      ),
    ).toBe('SHEET_LINK_NOT_PUBLIC');
  });
});
