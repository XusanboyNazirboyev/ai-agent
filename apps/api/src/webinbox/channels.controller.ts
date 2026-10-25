import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import {
  agentModePolicy,
  modeRefusalCode,
  type AgentModePolicy,
  type AgentModeValue,
  type ModeRefusalCode,
} from '../agent/agent-mode.js';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const MODES: AgentModeValue[] = ['OFF', 'SHADOW', 'LIVE'];

export interface ChannelAccountSummary {
  id: string;
  channelType: string;
  status: 'ACTIVE' | 'DISABLED';
  agentMode: AgentModeValue;
  /** Why a mode cannot be selected right now (absent: it can). */
  modeRefusals: Partial<Record<AgentModeValue, ModeRefusalCode>>;
  isTestAccount: boolean;
  /** Whether bot credentials are configured (never the credentials). */
  credentialsConfigured: boolean;
  operatorGroupConfigured: boolean;
  createdAt: Date;
}

const Body_ = z.object({ mode: z.enum(['OFF', 'SHADOW', 'LIVE']) });

/**
 * The tenant's messenger accounts for the web Channels and AI bot pages.
 * Exposes state only: no account key, credential reference, webhook secret
 * or chat id leaves the server. Changing the assistant mode is OWNER/ADMIN
 * only, obeys the same policy as the `agent:mode` command, and is audited.
 */
@Controller('api/v1/channels')
@UseGuards(SessionGuard)
export class ChannelsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  private policy(): AgentModePolicy {
    const get = <K extends keyof AppEnvironment>(key: K): AppEnvironment[K] =>
      this.config.get(key, { infer: true });
    return agentModePolicy({
      NODE_ENV: get('NODE_ENV'),
      LLM_PROVIDER: get('LLM_PROVIDER'),
      LLM_TRUSTED_PROVIDERS: get('LLM_TRUSTED_PROVIDERS'),
      LLM_ALLOW_REAL_CUSTOMER_DATA: get('LLM_ALLOW_REAL_CUSTOMER_DATA'),
    });
  }

  private summarize(
    row: {
      id: string;
      channelType: string;
      status: 'ACTIVE' | 'DISABLED';
      agentMode: AgentModeValue;
      isTestAccount: boolean;
      credentialRef: string | null;
      operatorChatId: string | null;
      createdAt: Date;
    },
    policy: AgentModePolicy,
  ): ChannelAccountSummary {
    const modeRefusals: ChannelAccountSummary['modeRefusals'] = {};
    for (const mode of MODES) {
      const code = modeRefusalCode(mode, policy, row);
      if (code) modeRefusals[mode] = code;
    }
    return {
      id: row.id,
      channelType: row.channelType,
      status: row.status,
      agentMode: row.agentMode,
      modeRefusals,
      isTestAccount: row.isTestAccount,
      credentialsConfigured: Boolean(row.credentialRef),
      operatorGroupConfigured: Boolean(row.operatorChatId),
      createdAt: row.createdAt,
    };
  }

  @Get()
  async list(
    @Req() request: InboxRequest,
  ): Promise<{ items: ChannelAccountSummary[] }> {
    const policy = this.policy();
    const rows = await this.prisma.channelAccount.findMany({
      where: { tenantId: request.principal!.tenantId },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    return { items: rows.map((row) => this.summarize(row, policy)) };
  }

  @Put(':id/agent-mode')
  async setMode(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<ChannelAccountSummary> {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    const parsed = Body_.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    const mode = parsed.data.mode;
    const account = await this.prisma.channelAccount.findFirst({
      where: { id, tenantId: principal.tenantId },
    });
    if (!account)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Not found',
        i18nKey: 'errors.notFound',
      });
    const policy = this.policy();
    const refusal = modeRefusalCode(mode, policy, account);
    if (refusal)
      throw new ForbiddenException({
        code: 'MODE_REFUSED',
        reason: refusal,
        message: 'This mode is not allowed now',
        i18nKey: 'errors.modeRefused',
      });
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.channelAccount.update({
        where: { id: account.id },
        data: { agentMode: mode },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: principal.tenantId,
          actorType: 'OPERATOR',
          actorId: principal.operatorId,
          action: 'channel.agent_mode_changed',
          entityType: 'channel_account',
          entityId: account.id,
          safeInputSummary: { from: account.agentMode, to: mode },
        },
      });
      return row;
    });
    return this.summarize(updated, policy);
  }
}
