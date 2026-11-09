import { describe, expect, it } from 'vitest';
import type { LocaleId, LocalePack } from '../core/locales/locale-pack.js';
import { INITIAL_LOCALE_PACKS } from '../locales/locale-packs.js';
import {
  CallOrchestrator,
  SentenceSplitter,
  type CallSummary,
} from './call-orchestrator.js';
import type {
  Clock,
  CallLeg,
  PlaybackRequest,
  ResponderEvent,
  TurnResponder,
} from './ports.js';
import type { HeardAudio } from './fakes.js';
import {
  FakeStreamingResponder,
  FakeStreamingSpeechToText,
  FakeStreamingTextToSpeech,
  InMemoryRecordingStore,
  MockSipGateway,
  ScriptedCaller,
} from './fakes.js';
import { VirtualClock } from './virtual-clock.js';

const LONG_ANSWER =
  'Birinchi gap juda uzun bo’lib, sekin aytiladi. Ikkinchi gap ham uzun. Uchinchi gap ham shunday.';

interface Setup {
  clock: VirtualClock;
  gateway: MockSipGateway;
  tts: FakeStreamingTextToSpeech;
  orchestrator: CallOrchestrator;
  pack: LocalePack;
}

function setup(opts: {
  locale?: LocaleId;
  wallNow?: Date;
  operatorNumber?: string;
  handoverOnTurns?: number[];
  answer?: string;
  chunkIntervalMs?: number;
  responder?: (clock: Clock) => TurnResponder;
}): Setup {
  const clock = new VirtualClock();
  const locale = opts.locale ?? 'uz-Latn';
  const gateway = new MockSipGateway({ clock });
  const stt = new FakeStreamingSpeechToText({ clock });
  const tts = new FakeStreamingTextToSpeech({
    clock,
    chunkIntervalMs: opts.chunkIntervalMs,
  });
  const responder =
    opts.responder?.(clock) ??
    new FakeStreamingResponder({
      clock,
      answer: opts.answer,
      handoverOnTurns: opts.handoverOnTurns,
    });
  const pack = INITIAL_LOCALE_PACKS.find((p) => p.id === locale)!;
  const orchestrator = new CallOrchestrator({
    clock,
    wallNow: (): Date => opts.wallNow ?? new Date('2026-11-10T07:00:00Z'),
    gateway,
    stt,
    tts,
    responder,
    locale,
    voiceTemplates: pack.templates.voice,
    tenant: {
      timeZone: 'Asia/Tashkent',
      operatorNumber: opts.operatorNumber ?? '+998711111111',
    },
  });
  return { clock, gateway, tts, orchestrator, pack };
}

async function startInbound(s: Setup): Promise<{
  leg: CallLeg;
  caller: ScriptedCaller;
  callId: string;
  call: Promise<CallSummary>;
}> {
  const callId = s.gateway.simulateInbound('+998901112233', '+998712000000');
  const leg = await s.gateway.acceptInbound(callId);
  const caller = new ScriptedCaller(s.clock, s.gateway.endpoint(callId));
  return { leg, caller, callId, call: s.orchestrator.handleCall(leg) };
}

describe('SentenceSplitter', () => {
  it('cuts sentences only when they are complete', () => {
    const sp = new SentenceSplitter();
    expect(sp.push('Salom. Qalay')).toEqual(['Salom.']);
    expect(sp.push('siz? Yaxshi')).toEqual(['Qalaysiz?']);
    expect(sp.flush()).toBe('Yaxshi');
    expect(sp.flush()).toBeUndefined();
  });

  it('never drops text before a period inside a word or number', () => {
    const sp = new SentenceSplitter();
    expect(sp.push('Sayt: www.markaz.uz.')).toEqual([]);
    expect(sp.push(' Narx 12.5 ming. Ha')).toEqual([
      'Sayt: www.markaz.uz.',
      'Narx 12.5 ming.',
    ]);
    expect(sp.flush()).toBe('Ha');
  });
});

describe('CallOrchestrator', () => {
  it('speaks the locale consent prompt first, then answers sentence by sentence', async () => {
    const s = setup({});
    const { caller, call } = await startInbound(s);
    const script = (async (): Promise<HeardAudio[]> => {
      await caller.waitForReply();
      await caller.say('Kurs narxi qancha?');
      const heard = await caller.waitForReply();
      caller.hangUp();
      return heard;
    })();
    const [summary, heard] = await s.clock.runUntil(
      Promise.all([call, script]),
    );
    expect(summary.spoken[0]).toBe(
      'Sifatni oshirish va xavfsizlik maqsadida suhbat yozib olinadi.',
    );
    expect(summary.spoken.slice(1)).toHaveLength(3);
    expect(new Set(heard.map((h) => h.sentenceIndex)).size).toBe(3);
    expect(summary.endedBy).toBe('caller');
    expect(summary.turns).toHaveLength(1);
    expect(summary.turns[0].isComplete()).toBe(true);
  });

  it('speaks a filler and checked sentences as given, filler outside the latency', async () => {
    const s = setup({
      responder: (clock) => ({
        async *respond(): AsyncIterable<ResponderEvent> {
          yield { type: 'filler', text: 'Bir daqiqa, tekshiryapman.' };
          await clock.sleep(400);
          yield { type: 'sentence', text: 'Ha, kurs bor' };
          yield { type: 'sentence', text: 'Yana savol bormi?' };
        },
      }),
    });
    const { caller, call } = await startInbound(s);
    const script = (async (): Promise<void> => {
      await caller.waitForReply();
      await caller.say('Ingliz tili kursi bormi?');
      await caller.waitForReply();
      caller.hangUp();
    })();
    const [summary] = await s.clock.runUntil(Promise.all([call, script]));
    expect(summary.spoken.slice(1)).toEqual([
      'Bir daqiqa, tekshiryapman.',
      'Ha, kurs bor',
      'Yana savol bormi?',
    ]);
    // First audio of the turn is the answer's, not the filler's.
    const turn = summary.turns[0]!;
    expect(turn.at('ttsFirstAudio')!).toBeGreaterThanOrEqual(
      turn.at('llmFirstToken')!,
    );
  });

  it('does not let the caller interrupt the consent prompt', async () => {
    const s = setup({});
    const { caller, call } = await startInbound(s);
    const script = (async (): Promise<void> => {
      await caller.say('Salom', 200); // speaks over the consent
      await caller.waitForReply();
      caller.hangUp();
    })();
    const [summary] = await s.clock.runUntil(Promise.all([call, script]));
    expect(summary.bargeIns).toBe(0);
    expect(summary.spoken[0]).toBe(s.pack.templates.voice.consentPrompt);
  });

  it('cancels TTS and clears playback on barge-in', async () => {
    const s = setup({ answer: LONG_ANSWER, chunkIntervalMs: 100 });
    const { caller, call, callId } = await startInbound(s);
    const script = (async (): Promise<void> => {
      await caller.waitForReply();
      await caller.say('Savol bering', 400);
      await s.clock.sleep(1500); // the answer is being played
      await caller.interrupt('To’xtang', 200);
      await caller.waitForReply();
      caller.hangUp();
    })();
    const [summary] = await s.clock.runUntil(Promise.all([call, script]));
    expect(summary.bargeIns).toBe(1);
    expect(s.tts.sessions[0].cancelCount).toBeGreaterThan(0);
    expect(s.gateway.endpoint(callId).clearCount()).toBeGreaterThan(0);
    // First answer was cut short; the interrupting utterance became a turn.
    expect(summary.turns).toHaveLength(2);
    expect(summary.turns[0].isComplete()).toBe(true);
  });

  it('barge-in also stops audio still playing out after generation finished', async () => {
    const s = setup({});
    const callId = s.gateway.simulateInbound('+998901112233', '+998712000000');
    const inner = await s.gateway.acceptInbound(callId);
    let playingOut = false;
    // A real leg (LiveKit) keeps queued audio after the turn has ended.
    const leg = Object.assign(Object.create(inner) as CallLeg, {
      isPlayingOut: (): boolean => playingOut,
      clearPlayback: (): void => {
        playingOut = false;
        inner.clearPlayback();
      },
    });
    const caller = new ScriptedCaller(s.clock, s.gateway.endpoint(callId));
    const call = s.orchestrator.handleCall(leg);
    const script = (async (): Promise<void> => {
      await caller.waitForReply();
      await caller.say('Kurs narxi qancha?');
      await caller.waitForReply();
      await s.clock.sleep(5000); // the turn is over; its audio still plays
      playingOut = true;
      await caller.interrupt('To’xtang', 200);
      await caller.waitForReply();
      caller.hangUp();
    })();
    const [summary] = await s.clock.runUntil(Promise.all([call, script]));
    expect(summary.bargeIns).toBe(1);
    expect(playingOut).toBe(false);
    expect(s.gateway.endpoint(callId).clearCount()).toBeGreaterThan(0);
    // Nothing was being generated: the only cancel is the one close() does.
    expect(s.tts.sessions[0].cancelCount).toBe(1);
  });

  it('transfers to the operator during working hours', async () => {
    const s = setup({ handoverOnTurns: [0] }); // 12:00 Tashkent
    const { caller, call } = await startInbound(s);
    const script = (async (): Promise<void> => {
      await caller.waitForReply();
      await caller.say('Operator bilan gaplashmoqchiman');
    })();
    const [summary] = await s.clock.runUntil(Promise.all([call, script]));
    expect(summary.handover).toEqual({
      kind: 'TRANSFER',
      toNumber: '+998711111111',
    });
    expect(summary.endedBy).toBe('transfer');
    expect(summary.spoken).toEqual([
      s.pack.templates.voice.consentPrompt,
      s.pack.templates.voice.transferNotice,
    ]);
    expect(s.gateway.transfers).toEqual([
      { callId: summary.callId, toNumber: '+998711111111' },
    ]);
  });

  it('creates a callback request after hours instead of transferring', async () => {
    const s = setup({
      handoverOnTurns: [0],
      wallNow: new Date('2026-11-10T16:00:00Z'), // 21:00 Tashkent
    });
    const { caller, call } = await startInbound(s);
    const script = (async (): Promise<void> => {
      await caller.waitForReply();
      await caller.say('Operator kerak');
    })();
    const [summary] = await s.clock.runUntil(Promise.all([call, script]));
    expect(summary.handover).toEqual({
      kind: 'CALLBACK_REQUEST',
      reason: 'AFTER_HOURS',
    });
    expect(summary.spoken[1]).toBe(s.pack.templates.voice.afterHoursCallback);
    expect(s.gateway.transfers).toHaveLength(0);
    expect(s.gateway.hangUps[0].reason).toBe('callback_requested');
  });

  it('falls back to a callback request when the transfer fails', async () => {
    const s = setup({ handoverOnTurns: [0] });
    s.gateway.injectFailure('transfer', 'sip 503');
    const { caller, call } = await startInbound(s);
    const script = (async (): Promise<void> => {
      await caller.waitForReply();
      await caller.say('Operator kerak');
    })();
    const [summary] = await s.clock.runUntil(Promise.all([call, script]));
    expect(summary.handover).toEqual({
      kind: 'CALLBACK_REQUEST',
      reason: 'TRANSFER_FAILED',
    });
    expect(summary.endedBy).toBe('agent');
  });

  it('works for an outbound call and reports injected placement failures', async () => {
    const s = setup({});
    s.gateway.injectFailure('place', 'busy');
    await expect(
      s.gateway.placeOutbound({ to: '+998901234567' }),
    ).rejects.toMatchObject({
      failure: 'PLACE_FAILED',
    });
    const leg = await s.gateway.placeOutbound({ to: '+998901234567' });
    expect(leg.direction).toBe('OUTBOUND');
    const caller = new ScriptedCaller(s.clock, s.gateway.endpoint(leg.callId));
    const call = s.orchestrator.handleCall(leg);
    const script = (async (): Promise<void> => {
      await caller.waitForReply();
      caller.hangUp();
    })();
    const [summary] = await s.clock.runUntil(Promise.all([call, script]));
    expect(summary.spoken[0]).toBe(s.pack.templates.voice.consentPrompt);
  });
});

describe('InMemoryRecordingStore', () => {
  it('restricts playback to OWNER and ADMIN and to the tenant', async () => {
    const store = new InMemoryRecordingStore();
    const put = await store.put({
      tenantId: 't1',
      callId: 'c1',
      data: new Uint8Array(1),
      contentType: 'audio/ogg',
      startedAt: new Date('2026-11-10T00:00:00Z'),
    });
    expect(put.retainUntil.toISOString()).toBe('2027-02-08T00:00:00.000Z');
    const req = (role: string, tenantId = 't1'): PlaybackRequest => ({
      tenantId,
      recordingId: put.recordingId,
      requester: { userId: 'u', role },
      ttlSeconds: 60,
    });
    expect((await store.createPlaybackUrl(req('ADMIN'))).ok).toBe(true);
    expect(await store.createPlaybackUrl(req('OPERATOR'))).toEqual({
      ok: false,
      reason: 'FORBIDDEN',
    });
    expect(await store.createPlaybackUrl(req('OWNER', 't2'))).toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
  });
});
