/**
 * Speech-to-text comparison for customer voice notes (ADR 042): runs the
 * owner's real recordings through the production `SpeechToText` adapters and
 * scores them against the exact words the owner wrote. Costs a little
 * provider credit (about 30 s of audio per mode).
 *
 *   pnpm exec tsx --env-file=<path to .env> scripts/stt-compare.ts \
 *     --dir <recordings> --references <file | words> \
 *     [--modes eleven-auto,eleven-uz,eleven-keyterms,gemini] \
 *     [--keyterms-file <txt>] [--out <results.json>]
 *
 * Modes (each is one adapter configuration):
 *   eleven-auto      ElevenLabs Scribe file endpoint, language detected by the provider
 *   eleven-uz        the same, language_code forced to `uz`
 *   eleven-keyterms  eleven-auto plus tenant keyterms
 *   gemini           gemini-3.5-transcribe (ADR 042), languages uz/ru/en offered
 *   gemini-uz        the same, offered languages narrowed to uz and ru
 *   gemini-vocab     gemini plus the tenant words as custom_vocabulary
 *   groq-v3          Groq whisper-large-v3, language detected (GROQ_API_KEY)
 *   groq-v3-uz       the same, language forced to uz
 *   groq-turbo       Groq whisper-large-v3-turbo, language detected
 *
 * Env: ELEVENLABS_API_KEY, and STT_API_KEY or GEMINI_API_KEY for `gemini`
 * (values never printed). Recordings, references and transcripts stay local.
 *
 * Reported per language group (from the reference): exact WER, and for
 * Uzbek also WER after transliterating both sides to Latin, plus how many
 * Uzbek transcripts came back in Cyrillic. Run-to-run variation is not
 * measured here (one run per mode).
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SpeechToText,
  TranscriptionResult,
} from '../src/core/speech/speech-to-text.js';
import { ElevenLabsSpeechToText } from '../src/speech/elevenlabs-speech-to-text.js';
import { WhisperSpeechToText } from '../src/speech/whisper-speech-to-text.js';
import {
  GeminiSpeechToText,
  sdkTranscribeCall,
} from '../src/speech/gemini-speech-to-text.js';
import {
  errorCount,
  hasCyrillic,
  languageOfReference,
  scriptFoldedErrors,
  summarizeWer,
  type WerLanguage,
  werOf,
  wordErrors,
} from '../src/voice/wer.js';

const AUDIO = /\.(ogg|oga|opus|m4a|mp3|wav)$/iu;
const DEFAULT_KEYTERMS = [
  'IELTS',
  'Chilonzor',
  'Yunusobod',
  'Samarqand',
  'Telegram',
  'Ingliz tili',
  'kurs',
  'guruh',
  'filial',
  'narxi',
];

type Mode =
  | 'eleven-auto'
  | 'eleven-uz'
  | 'eleven-keyterms'
  | 'gemini'
  | 'gemini-uz'
  | 'gemini-vocab'
  | 'groq-v3'
  | 'groq-v3-uz'
  | 'groq-turbo';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function durationOf(file: string): Promise<number> {
  return new Promise((done, fail) => {
    const probe = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        file,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    probe.stdout.on('data', (c: Buffer) => (out += c.toString()));
    probe.on('error', fail);
    probe.on('close', () => {
      const seconds = Number(out.trim());
      if (Number.isFinite(seconds) && seconds > 0) done(seconds);
      else fail(new Error(`cannot read duration of ${file}`));
    });
  });
}

function references(text: string): Map<string, string> {
  const byFile = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const bar = line.indexOf('|');
    if (bar < 0) continue;
    const said = line.slice(bar + 1).trim();
    if (said) byFile.set(line.slice(0, bar).trim(), said);
  }
  return byFile;
}

function adapterFor(
  mode: Mode,
  keyterms: readonly string[],
): { stt: SpeechToText; hint?: string } {
  if (mode.startsWith('groq')) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY is not set');
    return {
      stt: new WhisperSpeechToText({
        providerId: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey,
        model:
          mode === 'groq-turbo' ? 'whisper-large-v3-turbo' : 'whisper-large-v3',
        timeoutMs: 30_000,
      }),
      ...(mode === 'groq-v3-uz' ? { hint: 'uz-Latn' } : {}),
    };
  }
  if (mode.startsWith('gemini')) {
    const key = process.env.STT_API_KEY || process.env.GEMINI_API_KEY;
    if (!key) throw new Error('STT_API_KEY or GEMINI_API_KEY is not set');
    return {
      stt: new GeminiSpeechToText(
        sdkTranscribeCall(key),
        'gemini-3.5-transcribe',
        30_000,
        mode === 'gemini-vocab' ? keyterms : [],
      ),
      ...(mode === 'gemini-uz' ? { hint: 'uz-Latn' } : {}),
    };
  }
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
  return {
    stt: new ElevenLabsSpeechToText({
      apiKey,
      timeoutMs: 30_000,
      ...(mode === 'eleven-keyterms' ? { keyterms } : {}),
    }),
    ...(mode === 'eleven-uz' ? { hint: 'uz-Latn' } : {}),
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const dir = arg('dir');
  const refFile = arg('references');
  if (!dir || !refFile) throw new Error('--dir and --references are required');
  const modes = (
    arg('modes') ?? 'eleven-auto,eleven-uz,eleven-keyterms,gemini'
  ).split(',') as Mode[];
  const keytermsFile = arg('keyterms-file');
  const keyterms = keytermsFile
    ? readFileSync(keytermsFile, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    : DEFAULT_KEYTERMS;
  const said = references(readFileSync(refFile, 'utf8'));
  const files = readdirSync(dir)
    .filter((f) => AUDIO.test(f))
    .sort();
  for (const f of files)
    if (!said.has(f)) throw new Error(`no reference text for ${f}`);

  const clips = await Promise.all(
    files.map(async (file) => ({
      file,
      reference: said.get(file)!,
      language: languageOfReference(said.get(file)!),
      data: new Uint8Array(readFileSync(join(dir, file))),
      durationSeconds: await durationOf(join(dir, file)),
    })),
  );
  const totalSeconds = clips.reduce((s, c) => s + c.durationSeconds, 0);
  console.log(
    `${clips.length} recordings, ${totalSeconds.toFixed(0)} s of audio`,
  );

  type Row = {
    file: string;
    language: WerLanguage;
    reference: string;
    transcript: string;
    failure?: string;
    errors: ReturnType<typeof wordErrors>;
    folded: ReturnType<typeof wordErrors>;
    wrongScript: boolean;
    detected?: string;
    ms: number;
  };
  const results = new Map<Mode, Row[]>();
  for (const mode of modes) {
    const { stt, hint } = adapterFor(mode, keyterms);
    const rows: Row[] = [];
    for (const clip of clips) {
      const started = performance.now();
      const result: TranscriptionResult = await stt.transcribe(
        {
          data: clip.data,
          mimeType: 'audio/ogg',
          durationSeconds: clip.durationSeconds,
        },
        hint ? { languageHint: hint } : {},
      );
      const ms = performance.now() - started;
      const transcript = result.ok ? result.text : '';
      const errors = wordErrors(clip.reference, transcript);
      rows.push({
        file: clip.file,
        language: clip.language,
        reference: clip.reference,
        transcript,
        ...(result.ok ? {} : { failure: result.code }),
        errors,
        folded:
          clip.language === 'ru'
            ? errors
            : scriptFoldedErrors(clip.reference, transcript),
        wrongScript:
          clip.language !== 'ru' &&
          transcript !== '' &&
          hasCyrillic(transcript) !== (clip.language === 'uz-Cyrl'),
        ...(result.ok && result.language ? { detected: result.language } : {}),
        ms,
      });
    }
    results.set(mode, rows);
  }

  for (const [index, clip] of clips.entries()) {
    console.log(`\n[${index + 1} ${clip.language}] ${clip.reference}`);
    for (const mode of modes) {
      const row = results.get(mode)![index]!;
      console.log(
        `  ${mode.padEnd(16)} ${pct(werOf(row.errors)).padStart(6)}${row.wrongScript ? ' WRONG-SCRIPT' : ''}${row.failure ? ` FAILED ${row.failure}` : ''}${row.detected ? ` [${row.detected}]` : ''}  ${row.transcript}`,
      );
    }
  }

  // Providers that agree with each other but not with the written words
  // point at a reference that differs from what was said (only a listener
  // can settle it): flagged for the speaker, never corrected here.
  const suspect = new Set<number>();
  if (modes.length >= 3) {
    clips.forEach((_, index) => {
      const heard = modes.map((m) => results.get(m)![index]!);
      const texts = heard.map((r) => r.transcript);
      const agree: number[] = [];
      const against: number[] = [];
      texts.forEach((a, i) => {
        against.push(werOf(heard[i]!.folded));
        texts.forEach((b, j) => {
          if (j > i) agree.push(werOf(scriptFoldedErrors(a, b)));
        });
      });
      const mean = (xs: number[]): number =>
        xs.reduce((s, x) => s + x, 0) / xs.length;
      if (mean(agree) <= 0.3 && mean(against) >= 0.3) suspect.add(index);
    });
  }
  if (suspect.size > 0) {
    console.log(
      `\nProviders agree with each other but not with the reference on lines ${[...suspect].map((i) => i + 1).join(', ')}: a shared recognition error, or a reference that differs from what was said (the speaker decides).`,
    );
  }

  console.log('\nSummary (corpus WER = all errors / all reference words)');
  const groups: readonly WerLanguage[] = ['uz-Latn', 'uz-Cyrl', 'ru'];
  for (const mode of modes) {
    const rows = results.get(mode)!;
    for (const language of groups) {
      const part = rows.filter((r) => r.language === language);
      if (part.length === 0) continue;
      const exact = summarizeWer(part.map((r) => r.errors));
      const folded = summarizeWer(part.map((r) => r.folded));
      const wrong = part.filter((r) => r.wrongScript).length;
      console.log(
        `  ${mode.padEnd(16)} ${language.padEnd(7)} n=${part.length} exact ${pct(exact.wer)} (${errorCount(exact)}/${exact.referenceWords})${language === 'ru' ? '' : `  script-folded ${pct(folded.wer)}  wrong script ${wrong}/${part.length}`}`,
      );
    }
    const all = summarizeWer(rows.map((r) => r.folded));
    const median = [...rows.map((r) => r.ms)].sort((a, b) => a - b)[
      Math.floor(rows.length / 2)
    ]!;
    console.log(
      `  ${mode.padEnd(16)} ALL     script-folded ${pct(all.wer)} (${errorCount(all)}/${all.referenceWords})  median ${median.toFixed(0)} ms/clip, failed ${rows.filter((r) => r.failure).length}`,
    );
    if (suspect.size > 0) {
      const rest = summarizeWer(
        rows.filter((_, i) => !suspect.has(i)).map((r) => r.folded),
      );
      console.log(
        `  ${mode.padEnd(16)} without the flagged lines: script-folded ${pct(rest.wer)} (${errorCount(rest)}/${rest.referenceWords}), for information only`,
      );
    }
  }

  const out = arg('out');
  if (out) {
    writeFileSync(
      out,
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          modes,
          keyterms,
          totalSeconds,
          results: Object.fromEntries(results),
        },
        null,
        2,
      ),
    );
    console.log(`results written to ${out}`);
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? `${error.name}: ${error.message}` : 'failed',
  );
  process.exitCode = 1;
});
