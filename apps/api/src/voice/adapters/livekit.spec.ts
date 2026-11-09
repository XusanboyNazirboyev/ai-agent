import { describe, expect, it } from 'vitest';
import type { AudioFrame, CallEvent, TtsAudioChunk } from '../ports.js';
import { TelephonyError } from '../ports.js';
import { VirtualClock } from '../virtual-clock.js';
import { EnergyVad, rmsDbfs } from './energy-vad.js';
import {
  bytesToInt16,
  int16ToBytes,
  LiveKitTelephonyGateway,
  type RoomConnector,
  type RoomMedia,
  type SipControl,
} from './livekit.js';

const SAMPLES_PER_20MS = 320;

function tone(amplitude: number): Int16Array {
  const out = new Int16Array(SAMPLES_PER_20MS);
  for (let i = 0; i < out.length; i += 1)
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 200 * i) / 16000));
  return out;
}
const loud = (): Int16Array => tone(8000); // about -18 dBFS
const quiet = (): Int16Array => tone(30); // about -64 dBFS

class FakeMedia implements RoomMedia {
  audio = new Set<(s: Int16Array) => void>();
  gone = new Set<(r: string) => void>();
  published: Int16Array[] = [];
  cleared = 0;
  disconnected = false;
  onCallerAudio(h: (s: Int16Array) => void): () => boolean {
    this.audio.add(h);
    return () => this.audio.delete(h);
  }
  onCallerGone(h: (r: string) => void): () => boolean {
    this.gone.add(h);
    return () => this.gone.delete(h);
  }
  publish(s: Int16Array): Promise<void> {
    this.published.push(s);
    return Promise.resolve();
  }
  clearQueue(): void {
    this.cleared += 1;
  }
  disconnect(): Promise<void> {
    this.disconnected = true;
    return Promise.resolve();
  }
  speak(samples: Int16Array): void {
    for (const h of this.audio) h(samples);
  }
}

class FakeSip implements SipControl {
  dials: unknown[] = [];
  transfers: [string, string, string][] = [];
  ended: string[] = [];
  failTransfer = false;
  dial(o: {
    trunkId: string;
    to: string;
    roomName: string;
  }): Promise<{ participantIdentity: string }> {
    this.dials.push(o);
    return Promise.resolve({ participantIdentity: 'sip-callee' });
  }
  transfer(room: string, identity: string, to: string): Promise<void> {
    if (this.failTransfer)
      return Promise.reject(new Error('trunk refused REFER'));
    this.transfers.push([room, identity, to]);
    return Promise.resolve();
  }
  endCall(room: string): Promise<void> {
    this.ended.push(room);
    return Promise.resolve();
  }
}

function gateway(outboundTrunkId?: string): {
  gw: LiveKitTelephonyGateway;
  media: FakeMedia;
  sip: FakeSip;
  rooms: string[];
  clock: VirtualClock;
  events: CallEvent[];
} {
  const media = new FakeMedia();
  const sip = new FakeSip();
  const rooms: string[] = [];
  const connector: RoomConnector = {
    connect: (room) => {
      rooms.push(room);
      return Promise.resolve(media);
    },
  };
  const clock = new VirtualClock();
  const gw = new LiveKitTelephonyGateway({
    config: { url: 'wss://example.livekit.cloud', apiKey: 'k', apiSecret: 's' },
    clock,
    connector,
    sip,
    ...(outboundTrunkId ? { outboundTrunkId } : {}),
  });
  const events: CallEvent[] = [];
  gw.onCallEvent((e) => events.push(e));
  return { gw, media, sip, rooms, clock, events };
}

const SIP_KIND = 3; // ParticipantKind.SIP in @livekit/rtc-node 1.2.1

describe('energy VAD (turn taking)', () => {
  it('measures levels', () => {
    expect(rmsDbfs(loud())).toBeGreaterThan(-25);
    expect(rmsDbfs(quiet())).toBeLessThan(-55);
  });

  it('needs 120 ms of voice before speech and 600 ms of silence to end the utterance', () => {
    const vad = new EnergyVad();
    const speech = Array.from({ length: 10 }, () => vad.process(loud(), 20));
    expect(speech.findIndex((d) => d.speech)).toBe(5); // 6th frame = 120 ms
    const silence = Array.from({ length: 40 }, () => vad.process(quiet(), 20));
    expect(silence.findIndex((d) => d.endOfUtterance)).toBe(29); // 600 ms
    expect(silence.filter((d) => d.endOfUtterance)).toHaveLength(1);
  });

  it('a short click does not count as speech', () => {
    const vad = new EnergyVad();
    const decisions = [loud(), loud(), quiet(), quiet()].map((s) =>
      vad.process(s, 20),
    );
    expect(decisions.some((d) => d.speech || d.endOfUtterance)).toBe(false);
  });

  it('ends long utterances sooner (450 ms)', () => {
    const vad = new EnergyVad();
    for (let i = 0; i < 200; i += 1) vad.process(loud(), 20); // 4 s
    const silence = Array.from({ length: 30 }, () => vad.process(quiet(), 20));
    expect(silence.findIndex((d) => d.endOfUtterance)).toBe(22); // 460 ms
  });
});

describe('LiveKit telephony gateway', () => {
  it('turns a SIP participant_joined webhook into an incoming call and answers it by joining the room', async () => {
    const { gw, rooms, events } = gateway();
    gw.handleWebhookEvent({
      event: 'participant_joined',
      room: { name: 'call-room-1' },
      participant: {
        identity: 'sip-caller',
        kind: SIP_KIND,
        attributes: {
          'sip.phoneNumber': '+998901234567',
          'sip.trunkPhoneNumber': '+998712000000',
        },
      },
    });
    expect(events[0]).toEqual({
      type: 'incoming',
      callId: 'call-room-1',
      from: '+998901234567',
      to: '+998712000000',
    });
    const leg = await gw.acceptInbound('call-room-1');
    expect(rooms).toEqual(['call-room-1']);
    expect(leg.direction).toBe('INBOUND');
    expect(events.at(-1)).toEqual({ type: 'answered', callId: 'call-room-1' });
  });

  it('ignores non-SIP participants (e.g. the agent itself)', () => {
    const { gw, events } = gateway();
    gw.handleWebhookEvent({
      event: 'participant_joined',
      room: { name: 'r' },
      participant: { identity: 'agentcore-voice', kind: 0 },
    });
    expect(events).toEqual([]);
  });

  it('places an outbound call through the configured trunk after joining', async () => {
    const { gw, sip, rooms } = gateway('ST_trunk');
    const leg = await gw.placeOutbound({ to: '+998901112233' });
    expect(rooms).toHaveLength(1);
    expect(sip.dials[0]).toMatchObject({
      trunkId: 'ST_trunk',
      to: '+998901112233',
      roomName: rooms[0],
    });
    expect(leg.callId).toBe(rooms[0]);
  });

  it('refuses outbound without a trunk', async () => {
    const { gw } = gateway();
    await expect(
      gw.placeOutbound({ to: '+998901112233' }),
    ).rejects.toBeInstanceOf(TelephonyError);
  });

  it('transfers the SIP participant and maps a failure to TRANSFER_FAILED', async () => {
    const { gw, sip, events } = gateway('ST_trunk');
    const leg = await gw.placeOutbound({ to: '+998901112233' });
    await gw.transfer(leg.callId, '+998712223344');
    expect(sip.transfers[0]).toEqual([
      leg.callId,
      'sip-callee',
      '+998712223344',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'transferred' });
    sip.failTransfer = true;
    await expect(
      gw.transfer(leg.callId, '+998712223344'),
    ).rejects.toMatchObject({
      failure: 'TRANSFER_FAILED',
    });
  });

  it('caller hang-up ends the call once and disconnects the agent', async () => {
    const { gw, media, events } = gateway('ST_trunk');
    const leg = await gw.placeOutbound({ to: '+998901112233' });
    for (const h of media.gone) h('caller hung up');
    gw.handleWebhookEvent({
      event: 'participant_left',
      room: { name: leg.callId },
      participant: { kind: SIP_KIND },
    });
    expect(events.filter((e) => e.type === 'ended')).toHaveLength(1);
    await Promise.resolve();
    expect(media.disconnected).toBe(true);
  });
});

describe('LiveKit call leg', () => {
  it('converts PCM both ways', () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768]);
    expect(Array.from(bytesToInt16(int16ToBytes(samples)))).toEqual(
      Array.from(samples),
    );
  });

  it('emits caller frames with VAD flags and an end-of-utterance frame', async () => {
    const { gw, media } = gateway('ST');
    const leg = await gw.placeOutbound({ to: '+998900000000' });
    const frames: AudioFrame[] = [];
    leg.onAudio((f) => frames.push(f));
    for (let i = 0; i < 10; i += 1) media.speak(loud());
    for (let i = 0; i < 31; i += 1) media.speak(quiet());
    expect(frames[0]).toMatchObject({ durationMs: 20, speech: false });
    expect(frames[0]!.data).toHaveLength(640);
    expect(frames.some((f) => f.speech)).toBe(true);
    expect(frames.filter((f) => f.endOfUtterance)).toHaveLength(1);
  });

  it('schedules playout, reports it as playing, and barge-in clears the LiveKit queue', async () => {
    const { gw, media, clock } = gateway('ST');
    const leg = await gw.placeOutbound({ to: '+998900000000' });
    const chunk = (bytes: number): TtsAudioChunk => ({
      data: new Uint8Array(bytes),
      sentenceIndex: 0,
      firstOfSentence: true,
      lastOfSentence: false,
      durationMs: bytes / 32,
      emittedAtMs: 0,
    });
    expect(leg.sendAudio(chunk(3200)).playbackStartMs).toBe(0);
    // The second chunk starts after the first 100 ms.
    expect(leg.sendAudio(chunk(3201)).playbackStartMs).toBe(100);
    expect(leg.isPlayingOut?.()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(media.published.map((s) => s.length)).toEqual([1600, 1600]);
    leg.clearPlayback();
    expect(media.cleared).toBe(1);
    expect(leg.isPlayingOut?.()).toBe(false);
    // The odd trailing byte was dropped with the cleared audio.
    expect(leg.sendAudio(chunk(2)).playbackStartMs).toBe(clock.now());
  });
});
