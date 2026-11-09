/**
 * Uzbek STT word error rate on the owner's real recordings (ADR 045 slice 3,
 * step 6). Streams each recording to Scribe v2 Realtime through the same
 * adapter a call uses and scores it against
 * docs/voice/wer-recording-script-uz.md. Costs a little ElevenLabs credit.
 *
 *   pnpm exec tsx --env-file=<path to .env> scripts/voice-wer.ts \
 *     --dir <folder of recordings> [--references <file> | --map 01,02,...] \
 *     [--pace 2] \
 *     [--runs plain,keyterms,keyterms+previous] [--keyterms-file <txt>] \
 *     [--out <results.json>]
 *
 * Recordings: any format ffmpeg reads (Telegram .ogg, .m4a, .wav), decoded
 * to PCM 16 kHz mono. Files are taken in name order. Without `--map` each
 * file is paired with its closest script line from the `plain` run; that
 * pairing is printed and must be confirmed by the speaker (it can flatter
 * the score). `--references` gives the exact words of free-form recordings
 * instead: one `file name | what was said` per line (`#` lines ignored).
 * Recordings, references and transcripts stay local; never commit them.
 *
 * Runs: `plain` = no context; `keyterms` = a sample tenant vocabulary
 * (branch, course and brand words, no person names); `keyterms+previous` =
 * the same plus `previous_text` = a generic agent greeting. Only measured
 * differences are reported.
 *
 * Env: ELEVENLABS_API_KEY (value never printed).
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  ElevenLabsRealtimeStt,
  PCM_BYTES_PER_MS,
} from '../src/voice/adapters/elevenlabs.js';
import type { Clock } from '../src/voice/ports.js';
import {
  errorCount,
  hasCyrillic,
  languageOfReference,
  matchToReferences,
  scriptFoldedErrors,
  type WerLanguage,
  parseWerScript,
  summarizeWer,
  type WerReference,
  werOf,
  wordErrors,
} from '../src/voice/wer.js';

const SCRIPT_PATH = resolve(
  import.meta.dirname,
  '../../../docs/voice/wer-recording-script-uz.md',
);
const AUDIO = /\.(ogg|oga|opus|m4a|mp3|wav|aac|webm)$/iu;
const CHUNK_MS = 100;

/** Sample tenant vocabulary (an education centre); no customer names. */
const DEFAULT_KEYTERMS = [
  'Chilonzor',
  'Yunusobod',
  'Samarqand',
  'Telegram',
  'Ingliz tili',
  'IELTS',
  'so‘m',
  'filial',
  'kurs',
  'guruh',
  'boshlang‘ich',
  'qabul',
];
const PREVIOUS_TEXT =
  'Assalomu alaykum! O‘quv markazi, qanday yordam bera olaman?';

type Run = 'plain' | 'keyterms' | 'keyterms+previous';

const clock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function decode(file: string): Promise<Buffer> {
  return new Promise((done, fail) => {
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        file,
        '-f',
        's16le',
        '-ac',
        '1',
        '-ar',
        '16000',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    ffmpeg.stdout.on('data', (c: Buffer) => chunks.push(c));
    ffmpeg.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    ffmpeg.on('error', fail);
    ffmpeg.on('close', (code) =>
      code === 0
        ? done(Buffer.concat(chunks))
        : fail(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 200)}`)),
    );
  });
}

async function transcribe(
  stt: ElevenLabsRealtimeStt,
  pcm: Buffer,
  callId: string,
  pace: number,
  previousText?: string,
): Promise<string> {
  const session = await stt.open({
    locale: 'uz-Latn',
    callId,
    ...(previousText ? { previousText } : {}),
  });
  const finals: string[] = [];
  const committed = new Promise<void>((done) =>
    session.onTranscript((event) => {
      if (event.kind === 'final') {
        finals.push(event.text);
        done();
      }
    }),
  );
  const chunkBytes = CHUNK_MS * PCM_BYTES_PER_MS;
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    const data = pcm.subarray(offset, offset + chunkBytes);
    const last = offset + chunkBytes >= pcm.length;
    session.pushAudio({
      data,
      timestampMs: offset / PCM_BYTES_PER_MS,
      durationMs: data.length / PCM_BYTES_PER_MS,
      speech: !last,
      endOfUtterance: last,
    });
    await clock.sleep(CHUNK_MS / pace);
  }
  const timedOut = await Promise.race([
    committed.then(() => false),
    clock.sleep(15_000).then(() => true),
  ]);
  await session.close();
  if (session.failure) throw session.failure;
  if (timedOut) throw new Error(`${callId}: no committed transcript in 15 s`);
  return finals.join(' ').trim();
}

/** `file name | what was said` per recording; every recording must have one. */
function readOwnReferences(
  text: string,
  files: readonly string[],
): WerReference[] {
  const byFile = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const bar = line.indexOf('|');
    if (bar < 0) continue;
    const said = line.slice(bar + 1).trim();
    if (said) byFile.set(line.slice(0, bar).trim(), said);
  }
  return files.map((file, i) => {
    const said = byFile.get(file);
    if (!said) throw new Error(`--references: no text for ${file}`);
    return { id: String(i + 1).padStart(2, '0'), text: said, noisy: false };
  });
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const dir = arg('dir');
  if (!dir) throw new Error('--dir <folder of recordings> is required');
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
  const pace = Number(arg('pace') ?? 2);
  const runs = (arg('runs') ?? 'plain,keyterms,keyterms+previous').split(
    ',',
  ) as Run[];
  const keytermsFile = arg('keyterms-file');
  const keyterms = keytermsFile
    ? readFileSync(keytermsFile, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    : DEFAULT_KEYTERMS;

  const references = parseWerScript(readFileSync(SCRIPT_PATH, 'utf8'));
  const files = readdirSync(dir)
    .filter((f) => AUDIO.test(f))
    .sort();
  if (files.length === 0) throw new Error(`no recordings in ${dir}`);
  console.log(`${files.length} recordings, ${references.length} script lines`);

  const pcm: Buffer[] = [];
  for (const file of files) pcm.push(await decode(join(dir, file)));

  const transcripts: Record<Run, string[]> = {
    plain: [],
    keyterms: [],
    'keyterms+previous': [],
  };
  const sttPlain = new ElevenLabsRealtimeStt({ apiKey, clock });
  const sttTerms = new ElevenLabsRealtimeStt({ apiKey, clock, keyterms });
  for (const run of runs) {
    for (let i = 0; i < files.length; i++) {
      transcripts[run].push(
        await transcribe(
          run === 'plain' ? sttPlain : sttTerms,
          pcm[i]!,
          `wer-${run}-${i + 1}`,
          pace,
          run === 'keyterms+previous' ? PREVIOUS_TEXT : undefined,
        ),
      );
    }
  }

  // Which reference each file is.
  const referencesFile = arg('references');
  const own = referencesFile
    ? readOwnReferences(readFileSync(referencesFile, 'utf8'), files)
    : undefined;
  const explicit = arg('map')?.split(',');
  const basis = transcripts[runs[0]!];
  const mapping: WerReference[] = own
    ? own
    : explicit
      ? explicit.map((id) => {
          const ref = references.find((r) => r.id === id.trim());
          if (!ref) throw new Error(`--map: no script line ${id}`);
          return ref;
        })
      : matchToReferences(basis, references).map((m) =>
          references.find((r) => r.id === m.referenceId)!,
        );
  if (mapping.length !== files.length)
    throw new Error('mapping does not cover every recording');
  console.log(
    own
      ? `References: ${referencesFile}`
      : explicit
        ? 'Mapping: given by --map'
        : `Mapping: AUTO from the ${runs[0]} run, confirm with the speaker`,
  );

  const results = files.map((file, i) => {
    const ref = mapping[i]!;
    const language = languageOfReference(ref.text);
    const perRun = Object.fromEntries(
      runs.map((run) => {
        const transcript = transcripts[run][i]!;
        const errors = wordErrors(ref.text, transcript);
        // Uzbek only: the same words in the other script are not wrong words.
        const folded =
          language === 'ru' ? errors : scriptFoldedErrors(ref.text, transcript);
        const wrongScript =
          language !== 'ru' &&
          hasCyrillic(transcript) !== (language === 'uz-Cyrl');
        return [run, { transcript, errors, folded, wrongScript }];
      }),
    );
    return {
      file,
      line: ref.id,
      language,
      noisy: ref.noisy,
      reference: ref.text,
      perRun,
      durationMs: pcm[i]!.length / PCM_BYTES_PER_MS,
    };
  });

  for (const r of results) {
    console.log(
      `\n[${r.line} ${r.language}${r.noisy ? ' noise' : ''}] ${r.file} (${(r.durationMs / 1000).toFixed(1)} s)\n  ref: ${r.reference}`,
    );
    for (const run of runs) {
      const { transcript, errors, folded, wrongScript } = r.perRun[run]!;
      console.log(
        `  ${run.padEnd(18)} ${pct(werOf(errors)).padStart(6)} (${errorCount(errors)}/${errors.referenceWords}) script-folded ${pct(werOf(folded)).padStart(6)}${wrongScript ? ' WRONG-SCRIPT' : ''}  ${transcript}`,
      );
    }
  }
  console.log('\nSummary (corpus WER = all errors / all reference words)');
  const groups: readonly WerLanguage[] = ['uz-Latn', 'uz-Cyrl', 'ru'];
  for (const run of runs) {
    for (const language of groups) {
      const lines = results.filter((r) => r.language === language);
      if (lines.length === 0) continue;
      const exact = summarizeWer(lines.map((r) => r.perRun[run]!.errors));
      const folded = summarizeWer(lines.map((r) => r.perRun[run]!.folded));
      const wrong = lines.filter((r) => r.perRun[run]!.wrongScript).length;
      console.log(
        `  ${run.padEnd(18)} ${language.padEnd(7)} n=${lines.length} exact ${pct(exact.wer)} (S${exact.substitutions} D${exact.deletions} I${exact.insertions} / ${exact.referenceWords})${language === 'ru' ? '' : `  script-folded ${pct(folded.wer)}  wrong script ${wrong}/${lines.length}`}`,
      );
    }
  }
  console.log('Totals');
  for (const run of runs) {
    const all = summarizeWer(results.map((r) => r.perRun[run]!.errors));
    const quiet = summarizeWer(
      results.filter((r) => !r.noisy).map((r) => r.perRun[run]!.errors),
    );
    const noisy = summarizeWer(
      results.filter((r) => r.noisy).map((r) => r.perRun[run]!.errors),
    );
    console.log(
      `  ${run.padEnd(18)} all ${pct(all.wer)} (S${all.substitutions} D${all.deletions} I${all.insertions} / ${all.referenceWords})  quiet ${quiet.referenceWords ? pct(quiet.wer) : 'n/a'}  noise ${noisy.referenceWords ? pct(noisy.wer) : 'n/a'}`,
    );
  }
  console.log(`  keyterms used: ${keyterms.join(', ')}`);

  const out = arg('out');
  if (out) {
    writeFileSync(
      out,
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          runs,
          keyterms,
          previousText: PREVIOUS_TEXT,
          mapping: own ? 'references-file' : explicit ? 'explicit' : 'auto',
          results,
        },
        null,
        2,
      ),
    );
    console.log(`results written to ${out}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'failed');
  process.exitCode = 1;
});
