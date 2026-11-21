import { spawn } from 'node:child_process';

/**
 * Telegram plays a voice message from OGG/Opus, MP3 or M4A (Bot API
 * sendVoice, read 2026-11-21); Gemini TTS answers WAV. This turns a WAV into
 * OGG/Opus with ffmpeg (installed in the api image). Returns null on any
 * failure or timeout; nothing is logged.
 */
export function encodeWavToOggOpus(
  wav: Uint8Array,
  options: { ffmpeg?: string; timeoutMs?: number } = {},
): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: Uint8Array | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(
      options.ffmpeg ?? 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-c:a',
        'libopus',
        '-b:a',
        '32k',
        '-f',
        'ogg',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(null);
    }, options.timeoutMs ?? 15_000);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => done(null));
    child.on('close', (code) => {
      const out = Buffer.concat(chunks);
      done(code === 0 && out.byteLength > 0 ? new Uint8Array(out) : null);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(Buffer.from(wav));
  });
}
