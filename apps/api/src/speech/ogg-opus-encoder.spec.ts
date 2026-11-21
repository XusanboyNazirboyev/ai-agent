import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { encodeWavToOggOpus } from './ogg-opus-encoder.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** A WAV of `seconds` of silence, 24 kHz mono 16-bit (Gemini TTS's format). */
function silentWav(seconds: number): Uint8Array {
  const rate = 24_000;
  const data = rate * 2 * seconds;
  const buffer = Buffer.alloc(44 + data);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + data, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(data, 40);
  return new Uint8Array(buffer);
}

describe('encodeWavToOggOpus', () => {
  it.skipIf(!hasFfmpeg)('turns a WAV into OGG/Opus', async () => {
    const ogg = await encodeWavToOggOpus(silentWav(1));
    expect(ogg).not.toBeNull();
    expect(Buffer.from(ogg!.subarray(0, 4)).toString('latin1')).toBe('OggS');
  });

  it.skipIf(!hasFfmpeg)(
    'returns null for input that is not audio',
    async () => {
      expect(await encodeWavToOggOpus(new Uint8Array([1, 2, 3]))).toBeNull();
    },
  );

  it('returns null when the encoder is missing', async () => {
    expect(
      await encodeWavToOggOpus(silentWav(1), { ffmpeg: '/nonexistent/ffmpeg' }),
    ).toBeNull();
  });
});
