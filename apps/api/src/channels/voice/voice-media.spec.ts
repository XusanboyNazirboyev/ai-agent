/* eslint-disable @typescript-eslint/explicit-function-return-type -- test fixtures */
import { describe, expect, it, vi } from 'vitest';
import {
  VOICE_MEDIA_TTL_MS,
  VoiceMediaController,
  VoiceMediaStore,
} from './voice-media.js';

function store(base: string | undefined) {
  const saved = new Map<string, Buffer>();
  const redis = {
    set: vi.fn((key: string, value: Buffer, _px: 'PX', _ttl: number) => {
      saved.set(key, value);
      return Promise.resolve('OK');
    }),
    getBuffer: vi.fn((key: string) => Promise.resolve(saved.get(key) ?? null)),
    quit: vi.fn(() => Promise.resolve('OK')),
  };
  const config = {
    get: (key: string) => (key === 'PUBLIC_BASE_URL' ? base : undefined),
  };
  return { store: new VoiceMediaStore(config as never, redis), redis };
}

describe('VoiceMediaStore (Instagram voice replies by URL)', () => {
  it('stores the audio for ten minutes under an unguessable public URL', async () => {
    const { store: media, redis } = store('https://tezda.example/');
    const url = await media.put(new Uint8Array([1, 2, 3]));
    expect(url).toMatch(
      /^https:\/\/tezda\.example\/webhooks\/instagram\/voice\/[A-Za-z0-9_-]{32}\.aac$/u,
    );
    expect(redis.set.mock.calls[0]![2]).toBe('PX');
    expect(redis.set.mock.calls[0]![3]).toBe(VOICE_MEDIA_TTL_MS);
    const file = url!.split('/').pop()!;
    expect([...(await media.get(file))!]).toEqual([1, 2, 3]);
    // Two replies never share a URL.
    expect(await media.put(new Uint8Array([4]))).not.toBe(url);
  });

  it('serves nothing for a malformed or unknown name, and stores nothing without a base URL', async () => {
    const { store: media, redis } = store('https://tezda.example');
    for (const file of ['x.aac', '../etc/passwd', `${'a'.repeat(32)}.mp3`])
      expect(await media.get(file)).toBeNull();
    expect(redis.getBuffer).not.toHaveBeenCalled();
    await expect(
      new VoiceMediaController(media).get(`${'a'.repeat(32)}.aac`),
    ).rejects.toThrow();
    const none = store(undefined);
    expect(await none.store.put(new Uint8Array([1]))).toBeNull();
    expect(none.redis.set).not.toHaveBeenCalled();
  });
});
