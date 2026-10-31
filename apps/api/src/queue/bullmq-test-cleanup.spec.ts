import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isValidTestPrefix, cleanupTestQueue } from './bullmq-test-cleanup.js';

const obliterate = vi.fn();
const close = vi.fn();
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function () { return { obliterate, close }; }),
}));

describe('bullmq-test-cleanup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts valid test prefix', () => {
    expect(isValidTestPrefix('agentcore-test-12345678-1234-1234-1234-123456789abc')).toBe(true);
  });
  it('rejects bull', () => {
    expect(isValidTestPrefix('bull')).toBe(false);
  });
  it('rejects empty', () => {
    expect(isValidTestPrefix('')).toBe(false);
  });
  it('rejects invalid uuid', () => {
    expect(isValidTestPrefix('agentcore-test-not-a-uuid')).toBe(false);
  });
  it('rejects unrelated', () => {
    expect(isValidTestPrefix('foo')).toBe(false);
  });
  it('cleanup rejects invalid before redis op', async () => {
    await expect(cleanupTestQueue('bull', 'q')).rejects.toThrow();
  });
  it('cleanup calls obliterate without force', async () => {
    await cleanupTestQueue('agentcore-test-12345678-1234-1234-1234-123456789abc', 'q');
    expect(obliterate).toHaveBeenCalledWith();
  });
});
