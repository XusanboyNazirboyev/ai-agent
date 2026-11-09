/**
 * Minimal call orchestrator over the voice ports (ADR 045). Pure
 * orchestration, no LLM integration: consent prompt first, then
 * utterance -> responder -> sentence-by-sentence TTS, with barge-in and
 * handover. Facts stay code-rendered by whatever responder is plugged in.
 */
import type { LocaleId, LocaleTemplates } from '../core/locales/locale-pack.js';
import { AsyncQueue } from './async-queue.js';
import { VoiceTurnTimeline } from './latency-timeline.js';
import { decideHandover, type HandoverDecision } from './policies.js';
import type {
  CallEvent,
  CallLeg,
  Clock,
  SttSession,
  TelephonyGateway,
  TranscriptEvent,
  TtsSession,
  TurnResponder,
  StreamingSpeechToText,
  StreamingTextToSpeech,
} from './ports.js';

export interface OrchestratorDeps {
  readonly clock: Clock;
  /** Wall-clock time for tenant-hours policies (the Clock is monotonic only). */
  readonly wallNow: () => Date;
  readonly gateway: TelephonyGateway;
  readonly stt: StreamingSpeechToText;
  readonly tts: StreamingTextToSpeech;
  readonly responder: TurnResponder;
  readonly locale: LocaleId;
  readonly voiceTemplates: LocaleTemplates['voice'];
  readonly tenant: {
    readonly timeZone: string;
    readonly operatorNumber?: string;
  };
}

export interface CallSummary {
  readonly callId: string;
  /** Spoken phrases in order, consent first. */
  readonly spoken: readonly string[];
  readonly turns: readonly VoiceTurnTimeline[];
  readonly bargeIns: number;
  readonly handover?: HandoverDecision;
  readonly endedBy: 'caller' | 'agent' | 'transfer';
}

type Item =
  | {
      readonly type: 'final';
      readonly event: TranscriptEvent;
      readonly eosAt: number;
    }
  | { readonly type: 'ended'; readonly reason: string };

/** Splits streamed text into sentences; keeps the tail until it completes. */
export class SentenceSplitter {
  private buffer = '';

  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    const re = /[^.!?…]+[.!?…]+(?=\s|$)/g;
    let consumed = 0;
    for (const m of this.buffer.matchAll(re)) {
      out.push(m[0].trim());
      consumed = (m.index ?? 0) + m[0].length;
    }
    this.buffer = this.buffer.slice(consumed);
    return out.filter((s) => s.length > 0);
  }

  flush(): string | undefined {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest.length > 0 ? rest : undefined;
  }
}

export class CallOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async handleCall(leg: CallLeg): Promise<CallSummary> {
    const { deps } = this;
    const queue = new AsyncQueue<Item>();
    const spoken: string[] = [];
    const turns: VoiceTurnTimeline[] = [];
    let bargeIns = 0;
    let lastEosAt = deps.clock.now();
    let playing = false;
    let interruptible = false;
    let turnRunning = false;
    let turnAbort: AbortController | undefined;
    let handover: HandoverDecision | undefined;
    let endedBy: CallSummary['endedBy'];

    const stt: SttSession = await deps.stt.open({
      locale: deps.locale,
      callId: leg.callId,
    });
    const tts: TtsSession = await deps.tts.open({
      locale: deps.locale,
      callId: leg.callId,
    });

    const offTranscript = stt.onTranscript((event) => {
      if (event.kind === 'final' && event.text.trim().length > 0) {
        queue.push({ type: 'final', event, eosAt: lastEosAt });
      }
    });
    const offAudio = leg.onAudio((frame) => {
      if (frame.endOfUtterance) lastEosAt = deps.clock.now();
      if (
        frame.speech &&
        interruptible &&
        turnRunning &&
        turnAbort &&
        !turnAbort.signal.aborted
      ) {
        bargeIns += 1;
        playing = false;
        turnAbort.abort();
        tts.cancel();
        leg.clearPlayback();
      }
      stt.pushAudio(frame);
    });
    const offEvents = deps.gateway.onCallEvent((e: CallEvent) => {
      if (e.callId === leg.callId && e.type === 'ended') {
        queue.push({ type: 'ended', reason: e.reason });
      }
    });

    /** Speaks one sentence; returns false when cancelled by barge-in. */
    const speak = async (
      sentence: string,
      timeline?: VoiceTurnTimeline,
    ): Promise<boolean> => {
      spoken.push(sentence);
      playing = true;
      for await (const chunk of tts.speak(sentence)) {
        if (!playing) return false;
        timeline?.mark('ttsFirstAudio', deps.clock.now());
        const receipt = leg.sendAudio(chunk);
        timeline?.mark('playbackStart', receipt.playbackStartMs);
      }
      const completed = playing;
      playing = false;
      return completed;
    };

    try {
      // Consent first, before anything else; not interruptible.
      interruptible = false;
      await speak(deps.voiceTemplates.consentPrompt);
      interruptible = true;

      let turnIndex = 0;
      for (;;) {
        const item = await queue.next();
        if (item.type === 'ended') {
          endedBy = 'caller';
          break;
        }
        const timeline = new VoiceTurnTimeline(turnIndex);
        turns.push(timeline);
        timeline.mark('callerEndOfSpeech', item.eosAt);
        timeline.mark('sttFinal', deps.clock.now());

        turnRunning = true;
        const outcome = await this.runTurn({
          leg,
          tts,
          timeline,
          transcript: item.event.text,
          turnIndex,
          speak,
          setAbort: (a) => (turnAbort = a),
        });
        turnRunning = false;
        turnIndex += 1;

        if (outcome.handoverRequested) {
          interruptible = false;
          handover = decideHandover({
            now: deps.wallNow(),
            timeZone: deps.tenant.timeZone,
            operatorNumber: deps.tenant.operatorNumber,
          });
          if (handover.kind === 'TRANSFER') {
            await speak(deps.voiceTemplates.transferNotice);
            try {
              await deps.gateway.transfer(leg.callId, handover.toNumber);
              endedBy = 'transfer';
            } catch {
              // Transfer failed: fall back to a callback request.
              handover = {
                kind: 'CALLBACK_REQUEST',
                reason: 'TRANSFER_FAILED',
              };
              await speak(deps.voiceTemplates.afterHoursCallback);
              await deps.gateway.hangUp(leg.callId, 'callback_requested');
              endedBy = 'agent';
            }
          } else {
            await speak(deps.voiceTemplates.afterHoursCallback);
            await deps.gateway.hangUp(leg.callId, 'callback_requested');
            endedBy = 'agent';
          }
          break;
        }
      }
    } finally {
      offTranscript();
      offAudio();
      offEvents();
      await stt.close();
      await tts.close();
    }
    return {
      callId: leg.callId,
      spoken,
      turns,
      bargeIns,
      handover,
      endedBy,
    };
  }

  private async runTurn(args: {
    leg: CallLeg;
    tts: TtsSession;
    timeline: VoiceTurnTimeline;
    transcript: string;
    turnIndex: number;
    speak: (s: string, t?: VoiceTurnTimeline) => Promise<boolean>;
    setAbort: (a: AbortController) => void;
  }): Promise<{ handoverRequested: boolean }> {
    const { deps } = this;
    const abort = new AbortController();
    args.setAbort(abort);
    const sentences = new AsyncQueue<string | null>();
    const splitter = new SentenceSplitter();
    let handoverRequested = false;

    // Producer: stream the responder, cut sentences as they complete.
    const produce = async (): Promise<void> => {
      try {
        for await (const ev of deps.responder.respond(
          {
            callId: args.leg.callId,
            locale: deps.locale,
            transcript: args.transcript,
            turnIndex: args.turnIndex,
          },
          abort.signal,
        )) {
          if (abort.signal.aborted) return;
          if (ev.type === 'handover') {
            handoverRequested = true;
            return;
          }
          args.timeline.mark('llmFirstToken', deps.clock.now());
          for (const s of splitter.push(ev.text)) {
            args.timeline.mark('firstSentenceReady', deps.clock.now());
            sentences.push(s);
          }
        }
        const rest = splitter.flush();
        if (rest) {
          args.timeline.mark('firstSentenceReady', deps.clock.now());
          sentences.push(rest);
        }
      } finally {
        sentences.push(null);
      }
    };

    // Consumer: speak sentences in order; stop on barge-in.
    const consume = async (): Promise<void> => {
      for (;;) {
        const s = await sentences.next();
        if (s === null) return;
        if (abort.signal.aborted) continue; // drain
        const ok = await args.speak(s, args.timeline);
        if (!ok) abort.abort();
      }
    };

    await Promise.all([produce(), consume()]);
    return { handoverRequested };
  }
}
