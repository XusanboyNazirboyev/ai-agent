import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { downloadCsv } from './export-csv';

/** A file download answers 200, text/csv and a Content-Disposition filename. */
function csvResponse(disposition: string | null = null): Response {
  const headers: Record<string, string> = {
    'content-type': 'text/csv; charset=utf-8',
  };
  if (disposition) headers['content-disposition'] = disposition;
  return new Response('﻿person_id,name\r\n1,Ada\r\n', {
    status: 200,
    headers,
  });
}

/** The API error body shape: {statusCode, message, code, i18nKey}. */
function errorResponse(
  status: number,
  code: string,
  i18nKey: string,
): Response {
  return new Response(
    JSON.stringify({ statusCode: status, message: code, code, i18nKey }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

describe('downloadCsv', () => {
  const clicked: string[] = [];
  const fetchMock = vi.fn();

  beforeEach(() => {
    clicked.length = 0;
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:csv');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(`${this.download}|${this.href}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('saves the file under the Content-Disposition filename', async () => {
    fetchMock.mockResolvedValue(
      csvResponse('attachment; filename="people-20261112.csv"'),
    );
    const name = await downloadCsv('/api/v1/exports/people.csv?q=a', 'x.csv');
    expect(name).toBe('people-20261112.csv');
    expect(clicked).toEqual(['people-20261112.csv|blob:csv']);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/exports/people.csv?q=a',
      expect.objectContaining({ credentials: 'same-origin', method: 'GET' }),
    );
  });

  it('does not revoke the object URL before the browser can save it', async () => {
    fetchMock.mockResolvedValue(csvResponse());
    await downloadCsv('/p', 'p.csv');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('falls back to the given name without a filename header', async () => {
    fetchMock.mockResolvedValue(csvResponse());
    expect(await downloadCsv('/p', 'people.csv')).toBe('people.csv');
  });

  it('throws an ApiError with code and i18nKey for an error body', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(413, 'EXPORT_TOO_LARGE', 'errors.EXPORT_TOO_LARGE'),
    );
    const error = await downloadCsv('/p', 'p.csv').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 413,
      code: 'EXPORT_TOO_LARGE',
      i18nKey: 'errors.EXPORT_TOO_LARGE',
    });
    expect(clicked).toHaveLength(0);
  });

  it('maps a non-JSON error body to UNKNOWN and a network failure to NETWORK', async () => {
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 502 }));
    await expect(downloadCsv('/p', 'p.csv')).rejects.toMatchObject({
      status: 502,
      code: 'UNKNOWN',
    });
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(downloadCsv('/p', 'p.csv')).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK',
    });
  });
});
