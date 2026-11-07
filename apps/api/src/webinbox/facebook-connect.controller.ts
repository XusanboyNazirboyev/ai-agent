import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { FacebookOAuthClient } from '../channels/facebook/facebook-oauth.js';
import {
  InstagramApiError,
  InstagramGraphClient,
} from '../channels/instagram/instagram-graph.js';
import {
  OAuthStateLedger,
  OAuthStateLedgerUnavailableError,
} from '../channels/instagram/instagram-oauth-state-ledger.js';
import {
  OAuthStateError,
  STATE_TTL_MS,
} from '../channels/meta/meta-oauth-state.js';
import type { AppEnvironment } from '../config/environment.js';
import type { ChannelAccount } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  ChannelSecretStore,
  SecretsNotConfiguredError,
} from '../secrets/channel-secret-store.js';
import {
  credentialSource,
  enabledBefore,
  policyFrom,
  summarizeChannel,
  type ChannelAccountSummary,
} from './channel-summary.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

/** What the callback page sends back from Meta's redirect. */
const CompleteBody = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[^\s#]{1,2048}$/u),
  state: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,2048}$/u),
});

/** Webhook field for Messenger messages (subscribed per Page at enable). */
const WEBHOOK_FIELDS = ['messages'] as const;

const REFUSAL = {
  INVALID_BODY: { status: 400, i18nKey: 'errors.invalidBody' },
  ALREADY_CONNECTED: { status: 409, i18nKey: 'errors.alreadyConnected' },
  NOT_CONNECTED: { status: 409, i18nKey: 'errors.notConnected' },
  SECRETS_NOT_CONFIGURED: {
    status: 503,
    i18nKey: 'errors.secretsNotConfigured',
  },
  WEBHOOK_NOT_CONFIGURED: {
    status: 503,
    i18nKey: 'errors.WEBHOOK_NOT_CONFIGURED',
  },
  FACEBOOK_UNREACHABLE: {
    status: 502,
    i18nKey: 'errors.FACEBOOK_UNREACHABLE',
  },
  FACEBOOK_REJECTED: { status: 502, i18nKey: 'errors.FACEBOOK_REJECTED' },
  RATE_LIMITED: { status: 429, i18nKey: 'errors.rateLimited' },
  OAUTH_NOT_CONFIGURED: {
    status: 503,
    i18nKey: 'errors.OAUTH_NOT_CONFIGURED',
  },
  OAUTH_STATE_INVALID: {
    status: 400,
    i18nKey: 'errors.OAUTH_STATE_INVALID',
  },
  OAUTH_UNAVAILABLE: { status: 503, i18nKey: 'errors.OAUTH_UNAVAILABLE' },
  NO_FACEBOOK_PAGE: { status: 400, i18nKey: 'errors.NO_FACEBOOK_PAGE' },
  SEVERAL_FACEBOOK_PAGES: {
    status: 400,
    i18nKey: 'errors.SEVERAL_FACEBOOK_PAGES',
  },
} as const;

function refuse(code: keyof typeof REFUSAL): HttpException {
  const spec = REFUSAL[code];
  return new HttpException(
    { code, message: code, i18nKey: spec.i18nKey },
    spec.status,
  );
}

/**
 * Connecting a Facebook Page for Messenger from the web API (ADR 040 slice
 * 2). OWNER/ADMIN only, at most 10 calls a minute per operator, every change
 * audited without any secret. `oauth/start` → Facebook Login for Business →
 * the web callback page → `oauth/complete`, which stores the Page access
 * token encrypted (`facebook_page_access_token`). A new Page starts DISABLED
 * with the assistant OFF; enable subscribes it to `messages`.
 */
@Controller('api/v1/channels/facebook')
@UseGuards(SessionGuard)
export class FacebookConnectController {
  private readonly calls = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly secrets: ChannelSecretStore,
    private readonly graph: InstagramGraphClient,
    private readonly oauth: FacebookOAuthClient,
    private readonly ledger: OAuthStateLedger,
  ) {}

  private manager(request: InboxRequest): {
    tenantId: string;
    operatorId: string;
    sessionId: string;
  } {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    return {
      tenantId: principal.tenantId,
      operatorId: principal.operatorId,
      sessionId: principal.sessionId,
    };
  }

  private admit(request: InboxRequest): {
    tenantId: string;
    operatorId: string;
    sessionId: string;
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

  private async account(tenantId: string, id: string): Promise<ChannelAccount> {
    const account = await this.prisma.channelAccount.findFirst({
      where: { id, tenantId, channelType: 'facebook' },
    });
    if (!account)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Not found',
        i18nKey: 'errors.notFound',
      });
    return account;
  }

  private async meta<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof InstagramApiError)
        throw refuse(
          error.retryable ? 'FACEBOOK_UNREACHABLE' : 'FACEBOOK_REJECTED',
        );
      throw error;
    }
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

  private async summary(
    tenantId: string,
    id: string,
  ): Promise<ChannelAccountSummary> {
    const [row, saved, enabled] = await Promise.all([
      this.prisma.channelAccount.findFirstOrThrow({ where: { id, tenantId } }),
      this.prisma.channelSecret.findMany({
        where: { tenantId, channelAccountId: id },
        select: { purpose: true },
      }),
      enabledBefore(this.prisma, tenantId, [id]),
    ]);
    return summarizeChannel(
      row,
      policyFrom(this.config),
      credentialSource(row, new Set(saved.map((s) => s.purpose)), this.config),
      this.config.get('PUBLIC_BASE_URL', { infer: true }),
      enabled.has(id),
    );
  }

  /** Whether "Continue with Facebook" can work on this server. */
  @Get('oauth')
  setup(@Req() request: InboxRequest): { oauth: boolean } {
    this.manager(request);
    return { oauth: this.oauth.configured };
  }

  @Post('oauth/start')
  start(@Req() request: InboxRequest): { url: string } {
    const who = this.admit(request);
    if (!this.oauth.configured) throw refuse('OAUTH_NOT_CONFIGURED');
    return { url: this.oauth.authorizeUrl(this.oauth.state(who)) };
  }

  /**
   * The state is checked (sealed, this tenant, operator and session, not
   * expired) and spent once before Meta is called; a callback from another
   * session never spends it.
   */
  @Post('oauth/complete')
  async complete(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<ChannelAccountSummary> {
    const who = this.admit(request);
    if (!this.oauth.configured) throw refuse('OAUTH_NOT_CONFIGURED');
    if (!this.secrets.configured) throw refuse('SECRETS_NOT_CONFIGURED');
    const parsed = CompleteBody.safeParse(body);
    if (!parsed.success) throw refuse('INVALID_BODY');
    try {
      this.oauth.checkState(parsed.data.state, who);
    } catch (error) {
      if (error instanceof OAuthStateError) throw refuse('OAUTH_STATE_INVALID');
      throw error;
    }
    let first: boolean;
    try {
      first = await this.ledger.consume(parsed.data.state, STATE_TTL_MS);
    } catch (error) {
      if (error instanceof OAuthStateLedgerUnavailableError)
        throw refuse('OAUTH_UNAVAILABLE');
      throw error;
    }
    if (!first) throw refuse('OAUTH_STATE_INVALID');
    const pages = await this.meta(() => this.oauth.exchange(parsed.data.code));
    // The person picks the Page in Meta's dialog; tezda never guesses.
    if (pages.length === 0) throw refuse('NO_FACEBOOK_PAGE');
    if (pages.length > 1) throw refuse('SEVERAL_FACEBOOK_PAGES');
    const page = pages[0]!;

    const existing = await this.prisma.channelAccount.findUnique({
      where: {
        channelType_externalAccountId: {
          channelType: 'facebook',
          externalAccountId: page.pageId,
        },
      },
      select: { id: true, tenantId: true },
    });
    // Another tenant's Page: refuse without saying whose.
    if (existing && existing.tenantId !== who.tenantId)
      throw refuse('ALREADY_CONNECTED');
    const id = await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.channelAccount.update({
          where: { id: existing.id },
          data: { displayName: page.name },
        });
        return existing.id;
      }
      const row = await tx.channelAccount.create({
        data: {
          tenantId: who.tenantId,
          channelType: 'facebook',
          externalAccountId: page.pageId,
          displayName: page.name,
          status: 'DISABLED',
        },
        select: { id: true },
      });
      return row.id;
    });
    await this.secrets.put(
      { tenantId: who.tenantId, channelAccountId: id },
      'facebook_page_access_token',
      page.pageToken,
    );
    await this.audit(
      who,
      existing ? 'channel.facebook_reconnected' : 'channel.facebook_connected',
      id,
      { pageId: page.pageId },
    );
    return this.summary(who.tenantId, id);
  }

  /** Subscribes the Page to `messages`, then activates it. */
  @Post(':id/enable')
  async enable(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ChannelAccountSummary> {
    const who = this.admit(request);
    const account = await this.account(who.tenantId, id);
    if (
      !this.config.get('INSTAGRAM_APP_SECRET', { infer: true }) ||
      !this.config.get('INSTAGRAM_VERIFY_TOKEN', { infer: true })
    )
      throw refuse('WEBHOOK_NOT_CONFIGURED');
    let token: string | undefined;
    try {
      token = await this.secrets.get(
        { tenantId: who.tenantId, channelAccountId: id },
        'facebook_page_access_token',
      );
    } catch (error) {
      if (error instanceof SecretsNotConfiguredError)
        throw refuse('SECRETS_NOT_CONFIGURED');
      token = undefined;
    }
    if (!token) throw refuse('NOT_CONNECTED');
    const pageToken = token;
    await this.meta(() =>
      this.graph.subscribeMessengerPage(
        account.externalAccountId,
        pageToken,
        WEBHOOK_FIELDS,
      ),
    );
    await this.prisma.channelAccount.updateMany({
      where: { id, tenantId: who.tenantId },
      data: { status: 'ACTIVE' },
    });
    await this.audit(who, 'channel.facebook_enabled', id, {
      fields: WEBHOOK_FIELDS.join(','),
    });
    return this.summary(who.tenantId, id);
  }

  /** Stops processing: DISABLED and the assistant OFF. */
  @Post(':id/disable')
  async disable(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ChannelAccountSummary> {
    const who = this.admit(request);
    await this.account(who.tenantId, id);
    await this.prisma.channelAccount.updateMany({
      where: { id, tenantId: who.tenantId },
      data: { status: 'DISABLED', agentMode: 'OFF' },
    });
    await this.audit(who, 'channel.facebook_disabled', id);
    return this.summary(who.tenantId, id);
  }
}
