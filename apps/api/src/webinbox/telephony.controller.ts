import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Optional,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  callAnalysisMinutesOf,
  openPlanLimits,
} from '../access/plan-limits.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { SECRET_CIPHER } from '../secrets/channel-secret-store.js';
import type { SecretCipher } from '../secrets/secret-cipher.js';
import {
  ONLINEPBX_TRANSPORT,
  OnlinePbxClient,
  OnlinePbxError,
  parseOnlinePbxDomain,
  type OnlinePbxTransport,
} from '../telephony/onlinepbx-client.js';
import { sealTelephonyApiKey } from '../telephony/telephony-key.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const ConnectBody = z.object({
  domain: z.string().trim().min(1).max(253),
  apiKey: z.string().trim().min(1).max(500),
});

const REFUSAL = {
  INVALID_BODY: 400,
  INVALID_DOMAIN: 400,
  PLAN_REQUIRED: 403,
  PBX_REJECTED: 400,
  PBX_UNREACHABLE: 502,
  SECRETS_NOT_CONFIGURED: 503,
  RATE_LIMITED: 429,
} as const;

function refuse(code: keyof typeof REFUSAL): HttpException {
  return new HttpException(
    { code, message: code, i18nKey: `errors.${code}` },
    REFUSAL[code],
  );
}

export interface TelephonyStatus {
  /** Analysed minutes a month the plan includes; 0 means no call analysis. */
  minutesLimit: number;
  secretsConfigured: boolean;
  account: {
    provider: 'ONLINEPBX';
    domain: string;
    enabled: boolean;
    /** A key is saved (never the key itself). */
    connected: boolean;
    lastError: string | null;
    polledUntil: string | null;
  } | null;
}

/**
 * Connecting the tenant's PBX for call analysis (ADR 085). OWNER/ADMIN only,
 * CSRF-protected by the session guard, at most 10 changes a minute per
 * operator, audited without the key. The API key is checked against
 * OnlinePBX `auth.json` before it is saved, sealed, and never returned or
 * logged.
 */
@Controller('api/v1/telephony')
@UseGuards(SessionGuard)
export class TelephonyController {
  private readonly calls = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(SECRET_CIPHER) private readonly cipher?: SecretCipher,
    @Optional()
    @Inject(ONLINEPBX_TRANSPORT)
    private readonly transport?: OnlinePbxTransport | null,
  ) {}

  private manager(request: InboxRequest): {
    tenantId: string;
    operatorId: string;
  } {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    return { tenantId: principal.tenantId, operatorId: principal.operatorId };
  }

  private admit(request: InboxRequest): {
    tenantId: string;
    operatorId: string;
  } {
    const who = this.manager(request);
    const now = Date.now();
    const recent = (this.calls.get(who.operatorId) ?? []).filter(
      (at) => now - at < 60_000,
    );
    if (recent.length >= 10) throw refuse('RATE_LIMITED');
    recent.push(now);
    this.calls.set(who.operatorId, recent);
    return who;
  }

  private async audit(
    who: { tenantId: string; operatorId: string },
    action: string,
    id: string,
    summary: Record<string, string>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        tenantId: who.tenantId,
        actorType: 'OPERATOR',
        actorId: who.operatorId,
        action,
        entityType: 'telephony_account',
        entityId: id,
        safeInputSummary: summary,
      },
    });
  }

  @Get()
  async status(@Req() request: InboxRequest): Promise<TelephonyStatus> {
    const who = this.manager(request);
    const [limits, row] = await Promise.all([
      openPlanLimits(this.prisma, who.tenantId),
      this.prisma.telephonyAccount.findUnique({
        where: {
          tenantId_provider: { tenantId: who.tenantId, provider: 'ONLINEPBX' },
        },
      }),
    ]);
    return {
      minutesLimit: callAnalysisMinutesOf(limits),
      secretsConfigured: this.cipher !== undefined,
      account: row
        ? {
            provider: 'ONLINEPBX',
            domain: row.domain,
            enabled: row.enabled,
            connected: row.apiKeyCipher !== null,
            lastError: row.lastError,
            polledUntil: row.polledUntil?.toISOString() ?? null,
          }
        : null,
    };
  }

  @Post('onlinepbx')
  async connect(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<TelephonyStatus> {
    const who = this.admit(request);
    if (!this.cipher) throw refuse('SECRETS_NOT_CONFIGURED');
    const parsed = ConnectBody.safeParse(body);
    if (!parsed.success) throw refuse('INVALID_BODY');
    const domain = parseOnlinePbxDomain(parsed.data.domain);
    if (!domain) throw refuse('INVALID_DOMAIN');
    const limits = await openPlanLimits(this.prisma, who.tenantId);
    if (callAnalysisMinutesOf(limits) <= 0) throw refuse('PLAN_REQUIRED');

    try {
      await new OnlinePbxClient({
        domain,
        apiKey: parsed.data.apiKey,
        ...(this.transport ? { transport: this.transport } : {}),
      }).authenticate();
    } catch (error: unknown) {
      if (error instanceof OnlinePbxError && error.code === 'REJECTED')
        throw refuse('PBX_REJECTED');
      throw refuse('PBX_UNREACHABLE');
    }

    const key = sealTelephonyApiKey(
      this.cipher,
      who.tenantId,
      'ONLINEPBX',
      parsed.data.apiKey,
    );
    const existing = await this.prisma.telephonyAccount.findUnique({
      where: {
        tenantId_provider: { tenantId: who.tenantId, provider: 'ONLINEPBX' },
      },
      select: { id: true, domain: true, enabled: true },
    });
    // Reading starts at connect time (the poller falls back to updatedAt): a
    // new PBX, or one switched back on after a disconnect, does not import
    // the calls made meanwhile. A key change on a running PBX keeps its cursor.
    const cursor =
      existing && (existing.domain !== domain || !existing.enabled)
        ? { polledUntil: null }
        : {};
    const row = existing
      ? await this.prisma.telephonyAccount.update({
          where: { id: existing.id },
          data: { domain, enabled: true, lastError: null, ...cursor, ...key },
          select: { id: true },
        })
      : await this.prisma.telephonyAccount.create({
          data: {
            tenantId: who.tenantId,
            provider: 'ONLINEPBX',
            domain,
            ...key,
          },
          select: { id: true },
        });
    await this.audit(
      who,
      existing
        ? 'telephony.onlinepbx_reconnected'
        : 'telephony.onlinepbx_connected',
      row.id,
      { domain },
    );
    return this.status(request);
  }

  /** Stops reading calls and deletes the saved key; analysed calls stay. */
  @Delete('onlinepbx')
  @HttpCode(204)
  async disconnect(@Req() request: InboxRequest): Promise<void> {
    const who = this.admit(request);
    const row = await this.prisma.telephonyAccount.findUnique({
      where: {
        tenantId_provider: { tenantId: who.tenantId, provider: 'ONLINEPBX' },
      },
      select: { id: true },
    });
    if (!row) return;
    await this.prisma.telephonyAccount.update({
      where: { id: row.id },
      data: {
        enabled: false,
        apiKeyKeyId: null,
        apiKeyNonce: null,
        apiKeyCipher: null,
      },
    });
    await this.audit(who, 'telephony.onlinepbx_disconnected', row.id, {});
  }
}
