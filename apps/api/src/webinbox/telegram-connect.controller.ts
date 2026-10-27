import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  HttpException,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { AppEnvironment } from '../config/environment.js';
import {
  BOT_TOKEN_FORMAT,
  TelegramManagement,
  TelegramManagementError,
} from '../channels/telegram/telegram-management.js';
import type { ChannelAccount } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  ChannelSecretStore,
  SecretsNotConfiguredError,
} from '../secrets/channel-secret-store.js';
import { SecretDecryptionError } from '../secrets/secret-cipher.js';
import {
  credentialSource,
  policyFrom,
  summarizeChannel,
  type ChannelAccountSummary,
} from './channel-summary.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const ConnectBody = z.object({ botToken: z.string().trim().max(200) });
const GroupBody = z.object({
  chatId: z
    .string()
    .trim()
    .regex(/^-?\d{1,20}$/u)
    .nullable(),
});

const REFUSAL: Record<string, { status: number; i18nKey: string }> = {
  INVALID_TOKEN: { status: 400, i18nKey: 'errors.invalidToken' },
  ALREADY_CONNECTED: { status: 409, i18nKey: 'errors.alreadyConnected' },
  NOT_CONNECTED: { status: 409, i18nKey: 'errors.notConnected' },
  SECRETS_NOT_CONFIGURED: {
    status: 503,
    i18nKey: 'errors.secretsNotConfigured',
  },
  PUBLIC_URL_NOT_CONFIGURED: {
    status: 503,
    i18nKey: 'errors.publicUrlNotConfigured',
  },
  TELEGRAM_UNREACHABLE: { status: 502, i18nKey: 'errors.telegramUnreachable' },
  TELEGRAM_REJECTED: { status: 502, i18nKey: 'errors.telegramRejected' },
  // Disconnect could not remove the webhook at Telegram; the saved token is
  // kept so that the operator can try again.
  WEBHOOK_NOT_REMOVED: { status: 502, i18nKey: 'errors.webhookNotRemoved' },
  RATE_LIMITED: { status: 429, i18nKey: 'errors.rateLimited' },
  INVALID_BODY: { status: 400, i18nKey: 'errors.invalidBody' },
};

function refuse(code: keyof typeof REFUSAL): HttpException {
  const spec = REFUSAL[code];
  return new HttpException(
    { code, message: code, i18nKey: spec.i18nKey },
    spec.status,
  );
}

export interface TelegramTestResult {
  tokenValid: boolean;
  botUsername: string | null;
  status: 'ACTIVE' | 'DISABLED';
  webhook: {
    registered: boolean;
    matchesExpected: boolean | null;
    pendingUpdates: number;
    lastError: string | null;
    lastErrorAt: Date | null;
  } | null;
  operatorGroupConfigured: boolean;
}

/**
 * Connecting, checking and disconnecting a Telegram bot from the web UI
 * (ADR 028). OWNER/ADMIN only, CSRF-protected by the session guard, at most
 * 10 calls a minute per operator, every change audited without any secret.
 * The bot token and the generated webhook secret are stored encrypted and are
 * never part of a response. A new account starts DISABLED with the assistant
 * OFF; the webhook is registered only when it is enabled.
 */
@Controller('api/v1/channels')
@UseGuards(SessionGuard)
export class TelegramConnectController {
  private readonly logger = new Logger(TelegramConnectController.name);
  private readonly calls = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly secrets: ChannelSecretStore,
    private readonly management: TelegramManagement,
  ) {}

  private admit(request: InboxRequest): {
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
    const now = Date.now();
    const recent = (this.calls.get(principal.operatorId) ?? []).filter(
      (at) => now - at < 60_000,
    );
    if (recent.length >= 10) throw refuse('RATE_LIMITED');
    recent.push(now);
    this.calls.set(principal.operatorId, recent);
    return { tenantId: principal.tenantId, operatorId: principal.operatorId };
  }

  private requireSecrets(): void {
    if (!this.secrets.configured) throw refuse('SECRETS_NOT_CONFIGURED');
  }

  private async account(tenantId: string, id: string): Promise<ChannelAccount> {
    const account = await this.prisma.channelAccount.findFirst({
      where: { id, tenantId, channelType: 'telegram' },
    });
    if (!account)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Not found',
        i18nKey: 'errors.notFound',
      });
    return account;
  }

  private async summary(
    tenantId: string,
    id: string,
  ): Promise<ChannelAccountSummary> {
    const [row, saved] = await Promise.all([
      this.prisma.channelAccount.findFirstOrThrow({ where: { id, tenantId } }),
      this.prisma.channelSecret.findMany({
        where: { tenantId, channelAccountId: id },
        select: { purpose: true },
      }),
    ]);
    return summarizeChannel(
      row,
      policyFrom(this.config),
      credentialSource(row, new Set(saved.map((s) => s.purpose)), this.config),
      this.config.get('PUBLIC_BASE_URL', { infer: true }),
    );
  }

  private async audit(
    who: { tenantId: string; operatorId: string },
    action: string,
    id: string,
    summary: Record<string, string | boolean | null> = {},
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        tenantId: who.tenantId,
        actorType: 'OPERATOR',
        actorId: who.operatorId,
        action,
        entityType: 'channel_account',
        entityId: id,
        safeInputSummary: summary,
      },
    });
  }

  /** Runs a Telegram call and maps its failures to the API's own codes. */
  private async telegram<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof TelegramManagementError) throw refuse(error.code);
      if (error instanceof SecretsNotConfiguredError)
        throw refuse('SECRETS_NOT_CONFIGURED');
      throw error;
    }
  }

  @Post('telegram')
  async connect(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<ChannelAccountSummary> {
    const who = this.admit(request);
    this.requireSecrets();
    const parsed = ConnectBody.safeParse(body);
    if (!parsed.success) throw refuse('INVALID_BODY');
    const token = parsed.data.botToken;
    if (!BOT_TOKEN_FORMAT.test(token)) throw refuse('INVALID_TOKEN');
    const bot = await this.telegram(() => this.management.getMe(token));
    const displayName = bot.username ? `@${bot.username}` : bot.name || null;

    const existing = await this.prisma.channelAccount.findFirst({
      where: { channelType: 'telegram', externalAccountId: bot.id },
      select: { id: true, tenantId: true },
    });
    // Another tenant's bot looks the same as an unusable one: no oracle.
    if (existing && existing.tenantId !== who.tenantId)
      throw refuse('ALREADY_CONNECTED');
    let id = existing?.id;
    if (!id) {
      try {
        id = (
          await this.prisma.channelAccount.create({
            data: {
              tenantId: who.tenantId,
              channelType: 'telegram',
              externalAccountId: bot.id,
              status: 'DISABLED',
              displayName,
            },
            select: { id: true },
          })
        ).id;
      } catch {
        throw refuse('ALREADY_CONNECTED');
      }
    } else {
      await this.prisma.channelAccount.update({
        where: { id },
        data: { displayName },
      });
    }
    const owner = { tenantId: who.tenantId, channelAccountId: id };
    await this.telegram(async () => {
      await this.secrets.put(owner, 'bot_token', token);
      // Keep the webhook secret on a reconnect: Telegram already knows it.
      if (!(await this.secrets.exists(owner, 'webhook_secret')))
        await this.secrets.put(
          owner,
          'webhook_secret',
          randomBytes(32).toString('base64url'),
        );
    });
    await this.audit(
      who,
      existing ? 'channel.telegram_reconnected' : 'channel.telegram_connected',
      id,
      { botId: bot.id },
    );
    return this.summary(who.tenantId, id);
  }

  @Post(':id/enable')
  async enable(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ChannelAccountSummary> {
    const who = this.admit(request);
    this.requireSecrets();
    await this.account(who.tenantId, id);
    const owner = { tenantId: who.tenantId, channelAccountId: id };
    const [token, secret] = await Promise.all([
      this.secrets.get(owner, 'bot_token'),
      this.secrets.get(owner, 'webhook_secret'),
    ]);
    if (!token || !secret) throw refuse('NOT_CONNECTED');
    const base = this.config.get('PUBLIC_BASE_URL', { infer: true });
    if (!base) throw refuse('PUBLIC_URL_NOT_CONFIGURED');
    await this.telegram(() =>
      this.management.setWebhook(
        token,
        `${base.replace(/\/+$/u, '')}/webhooks/telegram/${id}`,
        secret,
      ),
    );
    await this.prisma.channelAccount.update({
      where: { id },
      data: { status: 'ACTIVE' },
    });
    await this.audit(who, 'channel.telegram_enabled', id);
    return this.summary(who.tenantId, id);
  }

  @Post(':id/disable')
  async disable(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ChannelAccountSummary> {
    const who = this.admit(request);
    await this.account(who.tenantId, id);
    await this.stop(who, id);
    await this.audit(who, 'channel.telegram_disabled', id);
    return this.summary(who.tenantId, id);
  }

  /**
   * Removes the webhook at Telegram with the saved bot token.
   * - `removed`: Telegram confirmed.
   * - `nothing_to_remove`: no bot token is saved.
   * - `token_unusable`: the token cannot be used any more (Telegram no longer
   *   accepts it, or the stored value cannot be decrypted), so there is
   *   nothing more this server can do for the webhook.
   * Any other Telegram failure is thrown.
   */
  private async removeWebhook(
    who: { tenantId: string },
    id: string,
  ): Promise<'removed' | 'nothing_to_remove' | 'token_unusable'> {
    if (!this.secrets.configured) return 'token_unusable';
    let token: string | undefined;
    try {
      token = await this.secrets.get(
        { tenantId: who.tenantId, channelAccountId: id },
        'bot_token',
      );
    } catch (error) {
      if (error instanceof SecretDecryptionError) return 'token_unusable';
      throw error;
    }
    if (!token) return 'nothing_to_remove';
    try {
      await this.management.deleteWebhook(token);
      return 'removed';
    } catch (error) {
      if (
        error instanceof TelegramManagementError &&
        error.code === 'INVALID_TOKEN'
      )
        return 'token_unusable';
      throw error;
    }
  }

  private async switchOff(id: string): Promise<void> {
    await this.prisma.channelAccount.update({
      where: { id },
      data: { status: 'DISABLED', agentMode: 'OFF' },
    });
  }

  /** Removes the webhook (best effort) and switches the account and its assistant off. */
  private async stop(who: { tenantId: string }, id: string): Promise<void> {
    try {
      await this.removeWebhook(who, id);
    } catch {
      // Telegram unreachable: the account is disabled below anyway, so its
      // webhook is refused until it expires. The saved token stays, so the
      // webhook can still be removed later.
      this.logger.warn(
        JSON.stringify({ event: 'telegram.webhook_not_removed', id }),
      );
    }
    await this.switchOff(id);
  }

  /**
   * The webhook is removed first and the saved secrets are deleted only when
   * that worked (or there was nothing to remove). When Telegram cannot be
   * reached the account is switched off, the secrets stay and the operator
   * gets WEBHOOK_NOT_REMOVED: calling this again retries.
   */
  @Delete(':id')
  @HttpCode(204)
  async disconnect(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const who = this.admit(request);
    await this.account(who.tenantId, id);
    let webhook: string;
    try {
      webhook = await this.removeWebhook(who, id);
    } catch (error) {
      await this.switchOff(id);
      const reason =
        error instanceof TelegramManagementError ? error.code : 'ERROR';
      await this.audit(who, 'channel.telegram_disconnect_pending', id, {
        reason,
      });
      this.logger.warn(
        JSON.stringify({ event: 'telegram.disconnect_pending', id, reason }),
      );
      if (error instanceof TelegramManagementError)
        throw refuse('WEBHOOK_NOT_REMOVED');
      throw error;
    }
    await this.switchOff(id);
    // The account row stays (its conversations belong to it); only its secrets go.
    await this.secrets.deleteAll({
      tenantId: who.tenantId,
      channelAccountId: id,
    });
    await this.audit(who, 'channel.telegram_disconnected', id, { webhook });
  }

  @Post(':id/test')
  async test(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TelegramTestResult> {
    const who = this.admit(request);
    this.requireSecrets();
    const account = await this.account(who.tenantId, id);
    const token = await this.secrets.get(
      { tenantId: who.tenantId, channelAccountId: id },
      'bot_token',
    );
    if (!token) throw refuse('NOT_CONNECTED');
    const base = this.config.get('PUBLIC_BASE_URL', { infer: true });
    const base_ = base?.replace(/\/+$/u, '');
    let bot;
    try {
      bot = await this.management.getMe(token);
    } catch (error) {
      if (
        error instanceof TelegramManagementError &&
        error.code === 'INVALID_TOKEN'
      )
        return {
          tokenValid: false,
          botUsername: null,
          status: account.status,
          webhook: null,
          operatorGroupConfigured: Boolean(account.operatorChatId),
        };
      throw await this.telegram(() => Promise.reject(error));
    }
    const info = await this.telegram(() => this.management.webhookInfo(token));
    const expected = base_ ? `${base_}/webhooks/telegram/${id}` : null;
    return {
      tokenValid: true,
      botUsername: bot.username,
      status: account.status,
      webhook: {
        registered: info.url !== '',
        matchesExpected: expected ? info.url === expected : null,
        pendingUpdates: info.pendingUpdateCount,
        lastError: info.lastErrorMessage,
        lastErrorAt: info.lastErrorDate,
      },
      operatorGroupConfigured: Boolean(account.operatorChatId),
    };
  }

  @Put(':id/operator-group')
  async operatorGroup(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<ChannelAccountSummary> {
    const who = this.admit(request);
    const parsed = GroupBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_CHAT_ID',
        message: 'Invalid chat id',
        i18nKey: 'errors.invalidChatId',
      });
    await this.account(who.tenantId, id);
    await this.prisma.channelAccount.update({
      where: { id },
      data: { operatorChatId: parsed.data.chatId },
    });
    await this.audit(who, 'channel.operator_group_changed', id, {
      configured: parsed.data.chatId !== null,
    });
    return this.summary(who.tenantId, id);
  }
}
