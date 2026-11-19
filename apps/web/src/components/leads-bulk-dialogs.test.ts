import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { BULK_CHUNK, runBulk } from './leads-bulk-dialogs';

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: (): string => 'errors.UNKNOWN',
}));

afterEach(() => vi.clearAllMocks());

const ids = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `lead-${i}`);

describe('runBulk (ADR 076)', () => {
  it('sends at most BULK_CHUNK leads per request and adds the results', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ updated: 100, failed: [] })
      .mockResolvedValueOnce({
        updated: 49,
        failed: [{ id: 'lead-149', code: 'NOT_FOUND' }],
      });
    const result = await runBulk(ids(150), {
      action: 'move',
      stageId: 'stage-1',
    });
    const bodies = vi
      .mocked(api)
      .mock.calls.map(([, o]) => (o as { body: { leadIds: string[] } }).body);
    expect(bodies.map((b) => b.leadIds.length)).toEqual([BULK_CHUNK, 50]);
    expect(result).toEqual({
      updated: 149,
      failed: [{ id: 'lead-149', code: 'NOT_FOUND' }],
    });
  });

  it('stops at a failed chunk and keeps the count of the chunks before it', async () => {
    const error = new Error('down');
    vi.mocked(api)
      .mockResolvedValueOnce({ updated: 100, failed: [] })
      .mockRejectedValueOnce(error);
    const result = await runBulk(ids(250), {
      action: 'assign',
      ownerOperatorId: null,
    });
    expect(vi.mocked(api)).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ updated: 100, failed: [], error });
  });
});
