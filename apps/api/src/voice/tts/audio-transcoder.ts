/**
 * Converts synthesised audio into what a channel accepts (ADR 055).
 * Telegram sendVoice: OGG/Opus (https://core.telegram.org/bots/api#sendvoice).
 * Instagram audio: aac, m4a, wav, mp4 (Meta messaging API docs, read
 * 2026-11-12).
 *
 * The ffmpeg binary is run with `spawn` and an argument array: no shell, and
 * no input value is ever interpolated into an argument (the input format hint
 * comes from a fixed table, the temp path is generated here).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TtsError } from "./ports.js";

export type TranscodeTarget = "ogg-opus" | "m4a-aac";

export interface TranscodeInput {
  readonly bytes: Uint8Array;
  readonly fromMime: string;
  readonly to: TranscodeTarget;
}

export interface TranscodedAudio {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface AudioTranscoder {
  transcode(input: TranscodeInput): Promise<TranscodedAudio>;
}

/** The slice of a child process this module uses (injectable in tests). */
export interface ChildLike {
  readonly stdin: {
    write(chunk: Uint8Array): unknown;
    end(chunk?: Uint8Array): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
  };
  readonly stdout: {
    on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  };
  readonly stderr: {
    on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  };
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnFn = (command: string, args: readonly string[]) => ChildLike;

export interface FfmpegOptions {
  readonly binary?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly spawn?: SpawnFn;
  readonly tmpDirectory?: string;
}

const INPUT_FORMATS: Readonly<Record<string, string>> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
};

const defaultSpawn: SpawnFn = (command, args) =>
  nodeSpawn(command, [...args], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as ChildLike;

export class FfmpegTranscoder implements AudioTranscoder {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly spawnFn: SpawnFn;
  private readonly tmpDirectory: string;

  constructor(options: FfmpegOptions = {}) {
    this.binary = options.binary ?? "ffmpeg";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 25 * 1024 * 1024;
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.tmpDirectory = options.tmpDirectory ?? tmpdir();
  }

  async transcode(input: TranscodeInput): Promise<TranscodedAudio> {
    if (input.bytes.length === 0) {
      throw new TtsError("EMPTY_AUDIO", "nothing to transcode");
    }
    const inputHint = INPUT_FORMATS[input.fromMime.toLowerCase()];
    const head = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      ...(inputHint ? ["-f", inputHint] : []),
      "-i",
      "pipe:0",
      "-vn",
    ];
    if (input.to === "ogg-opus") {
      const bytes = await this.run(
        [
          ...head,
          "-c:a",
          "libopus",
          "-b:a",
          "24k",
          "-ac",
          "1",
          "-ar",
          "48000",
          "-f",
          "ogg",
          "pipe:1",
        ],
        input.bytes,
        null,
      );
      return { bytes, mimeType: "audio/ogg" };
    }
    // m4a: `+faststart` moves the index to the front by rewriting the file,
    // which needs a seekable output, so a pipe cannot be used. Write to a
    // random-named temp file and always delete it.
    const path = join(this.tmpDirectory, `tts-${randomUUID()}.m4a`);
    try {
      await this.run(
        [
          ...head,
          "-c:a",
          "aac",
          "-b:a",
          "48k",
          "-ac",
          "1",
          "-movflags",
          "+faststart",
          "-f",
          "ipod",
          "-y",
          path,
        ],
        input.bytes,
        path,
      );
      const bytes = new Uint8Array(await readFile(path));
      if (bytes.length > this.maxOutputBytes) {
        throw new TtsError("AUDIO_TOO_LARGE", "transcoded audio too large");
      }
      return { bytes, mimeType: "audio/mp4" };
    } finally {
      await rm(path, { force: true });
    }
  }

  /** Runs ffmpeg; resolves with stdout bytes (empty when output is a file). */
  private run(
    args: readonly string[],
    stdin: Uint8Array,
    outputPath: string | null,
  ): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      let child: ChildLike;
      try {
        child = this.spawnFn(this.binary, args);
      } catch {
        reject(new TtsError("TRANSCODE_FAILED", "ffmpeg could not be started"));
        return;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      let settled = false;
      const finish = (error: TtsError | null, value?: Uint8Array): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value ?? new Uint8Array());
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new TtsError("TIMEOUT", "ffmpeg timed out"));
      }, this.timeoutMs);
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > this.maxOutputBytes) {
          child.kill("SIGKILL");
          finish(new TtsError("AUDIO_TOO_LARGE", "ffmpeg output too large"));
          return;
        }
        chunks.push(chunk);
      });
      // stderr is drained and discarded: it can echo input details.
      child.stderr.on("data", () => undefined);
      child.stdin.on("error", () => undefined);
      child.on("error", () =>
        finish(new TtsError("TRANSCODE_FAILED", "ffmpeg failed to run")),
      );
      child.on("close", (code) => {
        if (code !== 0) {
          finish(
            new TtsError("TRANSCODE_FAILED", `ffmpeg exited with ${code}`),
          );
          return;
        }
        const out = Buffer.concat(chunks);
        if (outputPath === null && out.length === 0) {
          finish(new TtsError("EMPTY_AUDIO", "ffmpeg produced no audio"));
          return;
        }
        finish(null, new Uint8Array(out));
      });
      child.stdin.end(stdin);
    });
  }
}
