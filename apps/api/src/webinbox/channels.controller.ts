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
import { modeRefusalCode, type AgentModePolicy } from '../agent/agent-mode.js';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { ChannelSecretStore } from '../secrets/channel-secret-store.js';
import {
  credentialSource,
  policyFrom,
  summarizeChannel,
  type ChannelAccountSummary,
} from './channel-summary.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

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
    private readonly secrets: ChannelSecretStore,
  ) {}

  private policy(): AgentModePolicy {
    return policyFrom(this.config);
  }

  private async summaries(tenantId: string): Promise<ChannelAccountSummary[]> {
    const [rows, secrets] = await Promise.all([
      this.prisma.channelAccount.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
      this.prisma.channelSecret.findMany({
        where: { tenantId },
        select: { channelAccountId: true, purpose: true },
      }),
    ]);
    const policy = this.policy();
    return rows.map((row) =>
      summarizeChannel(
        row,
        policy,
        credentialSource(
          row,
          new Set(
            secrets
              .filter((secret) => secret.channelAccountId === row.id)
              .map((secret) => secret.purpose),
          ),
          this.config,
        ),
        this.config.get('PUBLIC_BASE_URL', { infer: true }),
      ),
    );
  }

  @Get()
  async list(@Req() request: InboxRequest): Promise<{
    items: ChannelAccountSummary[];
    /** What this server can do for connecting channels (settings, not values). */
    capabilities: { secretsConfigured: boolean; publicUrlConfigured: boolean };
  }> {
    return {
      items: await this.summaries(request.principal!.tenantId),
      capabilities: {
        secretsConfigured: this.secrets.configured,
        publicUrlConfigured: Boolean(
          this.config.get('PUBLIC_BASE_URL', { infer: true }),
        ),
      },
    };
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
    return (await this.summaries(principal.tenantId)).find(
      (item) => item.id === updated.id,
    )!;
  }
}
