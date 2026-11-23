import { randomBytes } from 'node:crypto';
import {
  Controller,
  Get,
  Header,
  Injectable,
  NotFoundException,
  Optional,
  Param,
  StreamableFile,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { AppEnvironment } from '../../config/environment.js';
import { redisOptions } from '../../queue/redis-options.js';

/** How long Meta has to fetch a voice reply; then the audio is gone. */
export const VOICE_MEDIA_TTL_MS = 10 * 60 * 1000;
const KEY_PREFIX = 'agentcore:voice-media:';
const FILE = /^([A-Za-z0-9_-]{32})\.aac$/u;

export interface VoiceMediaRedis {
  set(key: string, value: Buffer, px: 'PX', ttlMs: number): Promise<unknown>;
  getBuffer(key: string): Promise<Buffer | null>;
  quit(): Promise<unknown>;
}

/**
 * Instagram takes audio only by URL (owner 2026-11-23: voice replies on
 * Instagram too). The spoken reply sits in Redis under a 192-bit random
 * token for ten minutes, never on disk and never in a log.
 */
@Injectable()
export class VoiceMediaStore implements OnModuleDestroy {
  private client?: VoiceMediaRedis;

  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    @Optional() client?: VoiceMediaRedis,
  ) {
    this.client = client;
  }

  /** The public URL of the stored audio, or null when there is no public base URL. */
  async put(audio: Uint8Array): Promise<string | null> {
    const base = this.config.get('PUBLIC_BASE_URL', { infer: true });
    if (!base) return null;
    const token = randomBytes(24).toString('base64url');
    await this.redis().set(
      KEY_PREFIX + token,
      Buffer.from(audio),
      'PX',
      VOICE_MEDIA_TTL_MS,
    );
    return `${base.replace(/\/+$/u, '')}/webhooks/instagram/voice/${token}.aac`;
  }

  async get(file: string): Promise<Buffer | null> {
    const token = FILE.exec(file)?.[1];
    return token ? this.redis().getBuffer(KEY_PREFIX + token) : null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit();
  }

  private redis(): VoiceMediaRedis {
    this.client ??= new Redis({
      ...redisOptions(this.config.get('REDIS_URL', { infer: true })),
      lazyConnect: false,
    });
    return this.client;
  }
}

/** Public, under /webhooks/* because only that path reaches the api (Caddyfile). */
@Controller('webhooks/instagram/voice')
export class VoiceMediaController {
  constructor(private readonly store: VoiceMediaStore) {}

  @Get(':file')
  @Header('Content-Type', 'audio/aac')
  @Header('Cache-Control', 'no-store')
  async get(@Param('file') file: string): Promise<StreamableFile> {
    const audio = await this.store.get(file);
    if (!audio) throw new NotFoundException();
    return new StreamableFile(audio);
  }
}
