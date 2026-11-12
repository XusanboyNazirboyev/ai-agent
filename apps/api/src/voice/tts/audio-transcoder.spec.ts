import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ChildLike,
  FfmpegTranscoder,
  type SpawnFn,
} from './audio-transcoder.js';
import { buildWav } from './wav.js';

interface FakeBehaviour {
  stdout?: Uint8Array[];
  exitCode?: number;
  hang?: boolean;
  spawnThrows?: boolean;
  errorEvent?: boolean;
  /** Writes the file named by the last argument (the m4a output). */
  writeOutput?: Uint8Array;
}

function fakeSpawn(behaviour: FakeBehaviour): {
  spawn: SpawnFn;
  calls: {
    command: string;
    args: readonly string[];
    stdin: Uint8Array[];
    killed: boolean;
  }[];
} {
  const calls: {
    command: string;
    args: readonly string[];
    stdin: Uint8Array[];
    killed: boolean;
  }[] = [];
  const spawn: SpawnFn = (command, args) => {
    if (behaviour.spawnThrows) throw new Error('ENOENT');
    const record = { command, args, stdin: [] as Uint8Array[], killed: false };
    calls.push(record);
    const child = new EventEmitter() as unknown as ChildLike & EventEmitter;
    const out = new EventEmitter();
    const err = new EventEmitter();
    Object.assign(child, {
      stdout: out,
      stderr: err,
      stdin: Object.assign(new EventEmitter(), {
        write: (chunk: Uint8Array) => record.stdin.push(chunk),
        end: (chunk?: Uint8Array) => {
          if (chunk) record.stdin.push(chunk);
          if (behaviour.hang) return;
          void (async (): Promise<void> => {
            if (behaviour.writeOutput) {
              await writeFile(
                args[args.length - 1] as string,
                behaviour.writeOutput,
              );
            }
            if (behaviour.errorEvent) {
              child.emit('error', new Error('boom'));
              return;
            }
            for (const chunk of behaviour.stdout ?? []) out.emit('data', chunk);
            child.emit('close', behaviour.exitCode ?? 0);
          })();
        },
      }),
      kill: () => {
        record.killed = true;
      },
    });
    return child;
  };
  return { spawn, calls };
}

const input = (
  to: 'ogg-opus' | 'm4a-aac',
): { bytes: Uint8Array; fromMime: string; to: 'ogg-opus' | 'm4a-aac' } => ({
  bytes: buildWav(48_000, 480),
  fromMime: 'audio/wav',
  to,
});

let tmp: string | undefined;
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('FfmpegTranscoder with an injected spawn', () => {
  it('runs ogg-opus with an argument array through pipes', async () => {
    const { spawn, calls } = fakeSpawn({
      stdout: [new Uint8Array([79, 103]), new Uint8Array([103, 83])],
    });
    const result = await new FfmpegTranscoder({ spawn }).transcode(
      input('ogg-opus'),
    );
    expect(Buffer.from(result.bytes).toString()).toBe('OggS');
    expect(result.mimeType).toBe('audio/ogg');
    const call = calls[0];
    expect(call?.command).toBe('ffmpeg');
    expect(call?.args).toEqual(
      expect.arrayContaining([
        '-c:a',
        'libopus',
        '-b:a',
        '24k',
        '-ac',
        '1',
        '-ar',
        '48000',
        'pipe:1',
      ]),
    );
    expect(call?.args).toEqual(
      expect.arrayContaining(['-f', 'wav', '-i', 'pipe:0']),
    );
    expect(call?.stdin[0]?.length).toBe(input('ogg-opus').bytes.length);
  });

  it('never puts input values into the arguments (unknown mime gets no hint)', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: [new Uint8Array([1])] });
    await new FfmpegTranscoder({ spawn }).transcode({
      bytes: new Uint8Array([1, 2]),
      fromMime: 'audio/x; rm -rf /',
      to: 'ogg-opus',
    });
    expect(calls[0]?.args.join(' ')).not.toContain('rm');
    expect(calls[0]?.args).not.toContain('-f wav');
    expect(calls[0]?.args.filter((a) => a === '-f')).toHaveLength(1);
  });

  it('writes m4a to a temp file, reads it back and deletes it', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tts-test-'));
    const ftyp = new Uint8Array([
      0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4,
    ]);
    const { spawn, calls } = fakeSpawn({ writeOutput: ftyp });
    const result = await new FfmpegTranscoder({
      spawn,
      tmpDirectory: tmp,
    }).transcode(input('m4a-aac'));
    expect(result.mimeType).toBe('audio/mp4');
    expect(Buffer.from(result.bytes.subarray(4, 8)).toString()).toBe('ftyp');
    const args = calls[0]?.args ?? [];
    expect(args).toEqual(
      expect.arrayContaining(['-c:a', 'aac', '-movflags', '+faststart']),
    );
    const outPath = args[args.length - 1] as string;
    expect(outPath.startsWith(tmp)).toBe(true);
    expect(existsSync(outPath)).toBe(false);
    expect(await readdir(tmp)).toEqual([]);
  });

  it('deletes the temp file even when ffmpeg fails', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tts-test-'));
    const { spawn } = fakeSpawn({
      writeOutput: new Uint8Array([1]),
      exitCode: 1,
    });
    await expect(
      new FfmpegTranscoder({ spawn, tmpDirectory: tmp }).transcode(
        input('m4a-aac'),
      ),
    ).rejects.toMatchObject({ code: 'TRANSCODE_FAILED' });
    expect(await readdir(tmp)).toEqual([]);
  });

  it('fails on a non-zero exit', async () => {
    const { spawn } = fakeSpawn({ exitCode: 1, stdout: [new Uint8Array([1])] });
    await expect(
      new FfmpegTranscoder({ spawn }).transcode(input('ogg-opus')),
    ).rejects.toMatchObject({
      code: 'TRANSCODE_FAILED',
    });
  });

  it('reports empty output as EMPTY_AUDIO', async () => {
    const { spawn } = fakeSpawn({});
    await expect(
      new FfmpegTranscoder({ spawn }).transcode(input('ogg-opus')),
    ).rejects.toMatchObject({
      code: 'EMPTY_AUDIO',
    });
  });

  it('rejects empty input without spawning', async () => {
    const { spawn, calls } = fakeSpawn({});
    await expect(
      new FfmpegTranscoder({ spawn }).transcode({
        bytes: new Uint8Array(),
        fromMime: 'audio/wav',
        to: 'ogg-opus',
      }),
    ).rejects.toMatchObject({ code: 'EMPTY_AUDIO' });
    expect(calls).toHaveLength(0);
  });

  it('kills ffmpeg on timeout', async () => {
    const { spawn, calls } = fakeSpawn({ hang: true });
    await expect(
      new FfmpegTranscoder({ spawn, timeoutMs: 30 }).transcode(
        input('ogg-opus'),
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(calls[0]?.killed).toBe(true);
  });

  it('kills ffmpeg when output exceeds the cap', async () => {
    const { spawn, calls } = fakeSpawn({
      stdout: [new Uint8Array(10), new Uint8Array(10)],
      hang: false,
    });
    await expect(
      new FfmpegTranscoder({ spawn, maxOutputBytes: 15 }).transcode(
        input('ogg-opus'),
      ),
    ).rejects.toMatchObject({ code: 'AUDIO_TOO_LARGE' });
    expect(calls[0]?.killed).toBe(true);
  });

  it('maps spawn errors to TRANSCODE_FAILED', async () => {
    await expect(
      new FfmpegTranscoder({
        spawn: fakeSpawn({ spawnThrows: true }).spawn,
      }).transcode(input('ogg-opus')),
    ).rejects.toMatchObject({ code: 'TRANSCODE_FAILED' });
    await expect(
      new FfmpegTranscoder({
        spawn: fakeSpawn({ errorEvent: true }).spawn,
      }).transcode(input('ogg-opus')),
    ).rejects.toMatchObject({ code: 'TRANSCODE_FAILED' });
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hasEncoders =
  hasFfmpeg &&
  /libopus/u.test(
    spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout.toString(),
  ) &&
  /\baac\b/u.test(
    spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout.toString(),
  );

describe.skipIf(!hasEncoders)(
  'FfmpegTranscoder with the real ffmpeg binary',
  () => {
    it('produces OggS for ogg-opus', async () => {
      const result = await new FfmpegTranscoder().transcode(input('ogg-opus'));
      expect(Buffer.from(result.bytes.subarray(0, 4)).toString()).toBe('OggS');
    });

    it('produces an ftyp box for m4a-aac', async () => {
      const result = await new FfmpegTranscoder().transcode(input('m4a-aac'));
      expect(Buffer.from(result.bytes.subarray(4, 8)).toString()).toBe('ftyp');
    });
  },
);
