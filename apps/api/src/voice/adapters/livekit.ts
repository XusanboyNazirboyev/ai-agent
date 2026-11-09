/**
 * LiveKit telephony adapter (ADR 045, V2: LiveKit Cloud first; URL and keys
 * are configuration, so a self-hosted server can replace it).
 *
 * A phone call is a LiveKit room: LiveKit SIP puts the caller in as a SIP
 * participant (inbound: trunk + dispatch rule; outbound: CreateSIPParticipant),
 * and this adapter joins the same room as the agent, reads the caller's audio
 * track and publishes its own track.
 *
 * Sources (read 2026-11-09):
 * - @livekit/rtc-node 1.2.1 typings: Room.connect(url, token, opts),
 *   RoomEvent.TrackSubscribed / ParticipantDisconnected / Disconnected,
 *   AudioStream(track, {sampleRate, numChannels}), AudioSource(sampleRate,
 *   numChannels, queueSizeMs), captureFrame, clearQueue,
 *   LocalAudioTrack.createAudioTrack, LocalParticipant.publishTrack.
 * - livekit-server-sdk 2.19.2 typings: AccessToken, SipClient
 *   (createSipParticipant, transferSipParticipant), RoomServiceClient
 *   (deleteRoom), WebhookReceiver.receive(body, authHeader).
 * - https://docs.livekit.io/reference/telephony/sip-participant/ : attributes
 *   `sip.phoneNumber` (caller for inbound, dialed number for outbound) and
 *   `sip.trunkPhoneNumber`; SIP participants have kind SIP.
 *
 * Turn taking: an adaptive energy VAD (energy-vad.ts) marks caller frames as
 * speech and flags the end of an utterance; the orchestrator uses the first
 * speech frame during playback as barge-in, and `clearPlayback` empties the
 * LiveKit audio queue at once.
 */
import {
  AudioFrame as RtcAudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  ParticipantKind,
  type RemoteParticipant,
  type RemoteTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import {
  AccessToken,
  RoomServiceClient,
  SipClient,
  WebhookReceiver,
} from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';

import type {
  AudioFrame,
  AudioSendReceipt,
  CallDirection,
  CallEvent,
  CallLeg,
  Clock,
  TelephonyGateway,
  TtsAudioChunk,
  Unsubscribe,
} from '../ports.js';
import { TelephonyError } from '../ports.js';
import { EnergyVad, type VadOptions } from './energy-vad.js';
import { PCM_SAMPLE_RATE } from './elevenlabs.js';

export const LIVEKIT_PROVIDER = 'livekit';
const FRAME_MS = 20;

// ------------------------------------------------------------------ seams

/** The agent's media connection to one room. */
export interface RoomMedia {
  /** Caller audio as PCM s16le mono at 16 kHz, in 20 ms frames. */
  onCallerAudio(handler: (samples: Int16Array) => void): Unsubscribe;
  /** The SIP caller left, or the room closed. */
  onCallerGone(handler: (reason: string) => void): Unsubscribe;
  /** Queues agent audio for playout, in order. */
  publish(samples: Int16Array): Promise<void>;
  clearQueue(): void;
  disconnect(): Promise<void>;
}

export interface RoomConnector {
  connect(roomName: string, identity: string): Promise<RoomMedia>;
}

export interface SipControl {
  dial(options: {
    readonly trunkId: string;
    readonly to: string;
    readonly roomName: string;
    readonly from?: string;
  }): Promise<{ readonly participantIdentity: string }>;
  transfer(
    roomName: string,
    participantIdentity: string,
    to: string,
  ): Promise<void>;
  endCall(roomName: string): Promise<void>;
}

export interface LiveKitConfig {
  /** wss://<project>.livekit.cloud or a self-hosted URL. */
  readonly url: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}

// ------------------------------------------------------- real connectors

function httpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//u, 'http$1://');
}

export async function agentToken(
  config: LiveKitConfig,
  roomName: string,
  identity: string,
  ttlSeconds = 3_600,
): Promise<string> {
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity,
    ttl: ttlSeconds,
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });
  return token.toJwt();
}

/** @livekit/rtc-node implementation of the media seam. */
export class RtcRoomConnector implements RoomConnector {
  constructor(private readonly config: LiveKitConfig) {}

  async connect(roomName: string, identity: string): Promise<RoomMedia> {
    const room = new Room();
    const audioHandlers = new Set<(samples: Int16Array) => void>();
    const goneHandlers = new Set<(reason: string) => void>();
    const gone = (reason: string): void => {
      for (const h of goneHandlers) h(reason);
    };

    room.on(
      RoomEvent.TrackSubscribed,
      (
        track: RemoteTrack,
        _publication: unknown,
        participant: RemoteParticipant,
      ) => {
        if (track.kind !== TrackKind.KIND_AUDIO) return;
        if (participant.kind !== ParticipantKind.SIP) return;
        const stream = new AudioStream(track, {
          sampleRate: PCM_SAMPLE_RATE,
          numChannels: 1,
          frameSizeMs: FRAME_MS,
        });
        void (async (): Promise<void> => {
          for await (const frame of stream) {
            for (const h of audioHandlers) h(frame.data);
          }
        })().catch(() => gone('audio stream failed'));
      },
    );
    room.on(
      RoomEvent.ParticipantDisconnected,
      (participant: RemoteParticipant) => {
        if (participant.kind === ParticipantKind.SIP) gone('caller hung up');
      },
    );
    room.on(RoomEvent.Disconnected, () => gone('room disconnected'));

    const token = await agentToken(this.config, roomName, identity);
    await room.connect(this.config.url, token, {
      autoSubscribe: true,
      dynacast: false,
    });
    // A deep queue (10 s): captureFrame then rarely waits, and barge-in
    // drops it with clearQueue.
    const source = new AudioSource(PCM_SAMPLE_RATE, 1, 10_000);
    const track = LocalAudioTrack.createAudioTrack('agent-voice', source);
    await room.localParticipant?.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );

    return {
      onCallerAudio: (handler) => {
        audioHandlers.add(handler);
        return () => audioHandlers.delete(handler);
      },
      onCallerGone: (handler) => {
        goneHandlers.add(handler);
        return () => goneHandlers.delete(handler);
      },
      publish: (samples) =>
        source.captureFrame(
          new RtcAudioFrame(samples, PCM_SAMPLE_RATE, 1, samples.length),
        ),
      clearQueue: () => source.clearQueue(),
      disconnect: async (): Promise<void> => {
        await source.close();
        await room.disconnect();
      },
    };
  }
}

/** livekit-server-sdk implementation of call control. */
export class ServerSipControl implements SipControl {
  private readonly sip: SipClient;
  private readonly rooms: RoomServiceClient;

  constructor(config: LiveKitConfig) {
    const host = httpUrl(config.url);
    this.sip = new SipClient(host, config.apiKey, config.apiSecret);
    this.rooms = new RoomServiceClient(host, config.apiKey, config.apiSecret);
  }

  async dial(options: {
    trunkId: string;
    to: string;
    roomName: string;
    from?: string;
  }): Promise<{ participantIdentity: string }> {
    const info = await this.sip.createSipParticipant(
      options.trunkId,
      options.to,
      options.roomName,
      {
        participantIdentity: `sip-${randomUUID()}`,
        waitUntilAnswered: true,
        ...(options.from ? { fromNumber: options.from } : {}),
      },
    );
    return { participantIdentity: info.participantIdentity };
  }

  transfer(roomName: string, identity: string, to: string): Promise<void> {
    return this.sip.transferSipParticipant(roomName, identity, to, {
      playDialtone: false,
    });
  }

  async endCall(roomName: string): Promise<void> {
    await this.rooms.deleteRoom(roomName);
  }
}

// ---------------------------------------------------------------- gateway

/** Minimal shape of a LiveKit webhook event this gateway reads. */
export interface LiveKitWebhookEvent {
  readonly event?: string;
  readonly room?: { readonly name?: string };
  readonly participant?: {
    readonly identity?: string;
    readonly kind?: number | string;
    readonly attributes?: Readonly<Record<string, string>>;
  };
}

export interface LiveKitGatewayOptions {
  readonly config: LiveKitConfig;
  readonly clock: Clock;
  readonly outboundTrunkId?: string;
  readonly agentIdentity?: string;
  readonly vad?: VadOptions;
  readonly connector?: RoomConnector;
  readonly sip?: SipControl;
}

interface CallState {
  readonly roomName: string;
  callerIdentity?: string;
  media?: RoomMedia;
  leg?: LiveKitCallLeg;
}

function isSipParticipant(kind: number | string | undefined): boolean {
  return kind === ParticipantKind.SIP || kind === 'SIP';
}

export class LiveKitTelephonyGateway implements TelephonyGateway {
  private readonly handlers = new Set<(event: CallEvent) => void>();
  private readonly calls = new Map<string, CallState>();
  private readonly connector: RoomConnector;
  private readonly sip: SipControl;
  private readonly receiver: WebhookReceiver;

  constructor(private readonly options: LiveKitGatewayOptions) {
    this.connector = options.connector ?? new RtcRoomConnector(options.config);
    this.sip = options.sip ?? new ServerSipControl(options.config);
    this.receiver = new WebhookReceiver(
      options.config.apiKey,
      options.config.apiSecret,
    );
  }

  onCallEvent(handler: (event: CallEvent) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Verifies a LiveKit webhook (signed JWT in Authorization) and handles it. */
  async receiveWebhook(
    body: string,
    authHeader: string | undefined,
  ): Promise<void> {
    const event = await this.receiver.receive(body, authHeader);
    this.handleWebhookEvent(event as unknown as LiveKitWebhookEvent);
  }

  /** callId is the LiveKit room name. */
  handleWebhookEvent(event: LiveKitWebhookEvent): void {
    const roomName = event.room?.name;
    const participant = event.participant;
    if (!roomName || !participant || !isSipParticipant(participant.kind))
      return;
    if (event.event === 'participant_joined') {
      if (this.calls.has(roomName)) return; // outbound leg we placed
      this.calls.set(roomName, {
        roomName,
        ...(participant.identity
          ? { callerIdentity: participant.identity }
          : {}),
      });
      this.emit({
        type: 'incoming',
        callId: roomName,
        from: participant.attributes?.['sip.phoneNumber'] ?? '',
        to: participant.attributes?.['sip.trunkPhoneNumber'] ?? '',
      });
    } else if (event.event === 'participant_left') {
      this.finish(roomName, 'caller hung up');
    }
  }

  async acceptInbound(callId: string): Promise<CallLeg> {
    const state = this.calls.get(callId);
    if (!state)
      throw new TelephonyError('ACCEPT_FAILED', `unknown call ${callId}`);
    try {
      const leg = await this.join(state, 'INBOUND', '');
      this.emit({ type: 'answered', callId });
      return leg;
    } catch (error) {
      throw new TelephonyError('ACCEPT_FAILED', describe(error));
    }
  }

  async placeOutbound(options: {
    to: string;
    from?: string;
  }): Promise<CallLeg> {
    const trunkId = this.options.outboundTrunkId;
    if (!trunkId)
      throw new TelephonyError(
        'PLACE_FAILED',
        'no outbound SIP trunk configured',
      );
    const roomName = `call-${randomUUID()}`;
    const state: CallState = { roomName };
    this.calls.set(roomName, state);
    try {
      // Join first so the greeting is not lost when the callee answers.
      const leg = await this.join(state, 'OUTBOUND', options.to);
      const dialed = await this.sip.dial({
        trunkId,
        to: options.to,
        roomName,
        ...(options.from ? { from: options.from } : {}),
      });
      state.callerIdentity = dialed.participantIdentity;
      this.emit({ type: 'answered', callId: roomName });
      return leg;
    } catch (error) {
      await this.cleanup(roomName);
      throw new TelephonyError('PLACE_FAILED', describe(error));
    }
  }

  async transfer(callId: string, toNumber: string): Promise<void> {
    const state = this.calls.get(callId);
    if (!state?.callerIdentity)
      throw new TelephonyError('TRANSFER_FAILED', `unknown call ${callId}`);
    try {
      await this.sip.transfer(state.roomName, state.callerIdentity, toNumber);
    } catch (error) {
      throw new TelephonyError('TRANSFER_FAILED', describe(error));
    }
    this.emit({ type: 'transferred', callId, toNumber });
  }

  async hangUp(callId: string, reason: string): Promise<void> {
    try {
      await this.sip.endCall(callId);
    } catch (error) {
      throw new TelephonyError('HANGUP_FAILED', describe(error));
    } finally {
      this.finish(callId, reason);
    }
  }

  private async join(
    state: CallState,
    direction: CallDirection,
    remoteNumber: string,
  ): Promise<LiveKitCallLeg> {
    const media = await this.connector.connect(
      state.roomName,
      this.options.agentIdentity ?? 'agentcore-voice',
    );
    state.media = media;
    const leg = new LiveKitCallLeg(
      state.roomName,
      direction,
      remoteNumber,
      media,
      this.options.clock,
      new EnergyVad(this.options.vad),
    );
    state.leg = leg;
    media.onCallerGone((reason) => this.finish(state.roomName, reason));
    return leg;
  }

  private finish(callId: string, reason: string): void {
    if (!this.calls.has(callId)) return;
    void this.cleanup(callId);
    this.emit({ type: 'ended', callId, reason });
  }

  private async cleanup(callId: string): Promise<void> {
    const state = this.calls.get(callId);
    this.calls.delete(callId);
    await state?.media?.disconnect().catch(() => undefined);
  }

  private emit(event: CallEvent): void {
    for (const h of this.handlers) h(event);
  }
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/gu, ' ')
    .slice(0, 200);
}

// ---------------------------------------------------------------- call leg

export function int16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return out;
}

export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.length / 2);
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i += 1) out[i] = view.getInt16(i * 2, true);
  return out;
}

export class LiveKitCallLeg implements CallLeg {
  private readonly handlers = new Set<(frame: AudioFrame) => void>();
  /** Call-clock time until which sent audio is scheduled to play. */
  private scheduledUntil = 0;
  private generation = 0;
  private chain: Promise<void> = Promise.resolve();
  private carry = new Uint8Array(0);

  constructor(
    readonly callId: string,
    readonly direction: CallDirection,
    readonly remoteNumber: string,
    private readonly media: RoomMedia,
    private readonly clock: Clock,
    private readonly vad: EnergyVad,
  ) {
    media.onCallerAudio((samples) => this.onCallerSamples(samples));
  }

  onAudio(handler: (frame: AudioFrame) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  sendAudio(chunk: TtsAudioChunk): AudioSendReceipt {
    const now = this.clock.now();
    const playbackStartMs = Math.max(now, this.scheduledUntil);
    // Keep whole samples: an odd trailing byte waits for the next chunk.
    let bytes = chunk.data;
    if (this.carry.length > 0) {
      bytes = new Uint8Array(this.carry.length + chunk.data.length);
      bytes.set(this.carry);
      bytes.set(chunk.data, this.carry.length);
    }
    const even = bytes.length - (bytes.length % 2);
    this.carry = bytes.slice(even);
    if (even > 0) {
      const samples = bytesToInt16(bytes.subarray(0, even));
      this.scheduledUntil =
        playbackStartMs + (samples.length * 1000) / PCM_SAMPLE_RATE;
      const generation = this.generation;
      this.chain = this.chain
        .then(() =>
          generation === this.generation
            ? this.media.publish(samples)
            : undefined,
        )
        .catch(() => undefined);
    }
    return { playbackStartMs };
  }

  clearPlayback(): void {
    this.generation += 1;
    this.carry = new Uint8Array(0);
    this.media.clearQueue();
    this.scheduledUntil = this.clock.now();
  }

  isPlayingOut(): boolean {
    return this.clock.now() < this.scheduledUntil;
  }

  private onCallerSamples(samples: Int16Array): void {
    const durationMs = (samples.length * 1000) / PCM_SAMPLE_RATE;
    const decision = this.vad.process(samples, durationMs);
    const frame: AudioFrame = {
      data: int16ToBytes(samples),
      timestampMs: this.clock.now() - durationMs,
      durationMs,
      speech: decision.speech,
      ...(decision.endOfUtterance ? { endOfUtterance: true } : {}),
    };
    for (const h of this.handlers) h(frame);
  }
}
