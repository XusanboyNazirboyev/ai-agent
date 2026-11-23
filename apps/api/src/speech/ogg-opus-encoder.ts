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
  return transcode(
    wav,
    ['-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg'],
    options,
  );
}

/**
 * Instagram audio attachments accept aac, m4a, wav or mp4 up to 25 MB (Meta
 * "Instagram API with Instagram Login: Send Messages", read 2026-11-23).
 * ADTS AAC streams through a pipe (an .m4a needs a seekable output).
 */
export function encodeToAac(
  audio: Uint8Array,
  options: { ffmpeg?: string; timeoutMs?: number } = {},
): Promise<Uint8Array | null> {
  return transcode(
    audio,
    ['-c:a', 'aac', '-b:a', '48k', '-f', 'adts'],
    options,
  );
}

function transcode(
  input: Uint8Array,
  output: readonly string[],
  options: { ffmpeg?: string; timeoutMs?: number },
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
        ...output,
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
    child.stdin.end(Buffer.from(input));
  });
}
