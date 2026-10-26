import { describe, expect, it } from 'vitest';
import { assertUtcSession } from './postgres-adapter.js';

const session = (
  zone: string | undefined,
): Parameters<typeof assertUtcSession>[0] =>
  ({
    $queryRaw: () => Promise.resolve(zone === undefined ? [] : [{ zone }]),
  }) as unknown as Parameters<typeof assertUtcSession>[0];

describe('assertUtcSession (DEF-007)', () => {
  it('accepts a UTC session', async () => {
    await expect(assertUtcSession(session('UTC'))).resolves.toBeUndefined();
    await expect(assertUtcSession(session('Etc/UTC'))).resolves.toBeUndefined();
  });

  it('refuses any other session zone, naming it', async () => {
    await expect(assertUtcSession(session('Asia/Tashkent'))).rejects.toThrow(
      /Asia\/Tashkent, not UTC/,
    );
    await expect(assertUtcSession(session(undefined))).rejects.toThrow(
      /unknown, not UTC/,
    );
  });
});
