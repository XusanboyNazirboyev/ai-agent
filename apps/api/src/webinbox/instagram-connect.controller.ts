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
import {
  readInstagramCredential,
  type InstagramCredential,
} from '../channels/instagram/instagram-credential.js';
import {
  InstagramApiError,
  InstagramGraphClient,
} from '../channels/instagram/instagram-graph.js';
import {
  OAuthStateLedger,
  OAuthStateLedgerUnavailableError,
} from '../channels/instagram/instagram-oauth-state-ledger.js';
import {
  InstagramOAuthClient,
  STATE_TTL_MS,
  OAuthStateError,
} from '../channels/instagram/instagram-oauth.js';
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

/** Instagram User access tokens are opaque; bound the size, refuse whitespace. */
const ConnectBody = z.object({
  accessToken: z
    .string()
    .trim()
    .regex(/^\S{20,2048}$/u),
});

/** What the callback page sends back from Instagram's redirect. */
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

/** Webhook field for direct messages (subscribed per account at enable). */
// ADR 044 (owner approved 2026-11-09): carousel taps arrive as
// `messaging_postbacks`, listed for Instagram Login and Unified login in the
// webhook fields matrix (webhooks/fields.md, read 2026-11-09).
const WEBHOOK_FIELDS = ['messages', 'messaging_postbacks'] as const;

const REFUSAL = {
  INVALID_BODY: { status: 400, i18nKey: 'errors.invalidBody' },
  INVALID_TOKEN: { status: 400, i18nKey: 'errors.invalidToken' },
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
  INSTAGRAM_UNREACHABLE: {
    status: 502,
    i18nKey: 'errors.INSTAGRAM_UNREACHABLE',
  },
  INSTAGRAM_REJECTED: { status: 502, i18nKey: 'errors.INSTAGRAM_REJECTED' },
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
  NO_INSTAGRAM_ACCOUNT: {
    status: 400,
    i18nKey: 'errors.NO_INSTAGRAM_ACCOUNT',
  },
  SEVERAL_INSTAGRAM_ACCOUNTS: {
    status: 400,
    i18nKey: 'errors.SEVERAL_INSTAGRAM_ACCOUNTS',
  },
} as const;

/** How the token was obtained, and which secret purpose holds it. */
type Via = 'token' | 'oauth';

function refuse(code: keyof typeof REFUSAL): HttpException {
  const spec = REFUSAL[code];
  return new HttpException(
    { code, message: code, i18nKey: spec.i18nKey },
    spec.status,
  );
}

/**
 * Connecting an Instagram professional account from the web API (ADR 031,
 * ADR 028 secret store). OWNER/ADMIN only, at most 10 calls a minute per
 * operator, every change audited without any secret. One click: Instagram
 * API with Unified login (`oauth/start` → Meta's dialog → the web callback
 * page → `oauth/complete`), which stores a Business Integration System User
 * token (ADR 031 amendment 2026-11-05). Fallback: a pasted Instagram User
 * access token with `instagram_business_basic` and
 * `instagram_business_manage_messages`. A new account starts DISABLED with
 * the assistant OFF.
 */
@Controller('api/v1/channels/instagram')
@UseGuards(SessionGuard)
export class InstagramConnectController {
  private readonly calls = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly secrets: ChannelSecretStore,
    private readonly graph: InstagramGraphClient,
    private readonly oauth: InstagramOAuthClient,
    private readonly ledger: OAuthStateLedger,
  ) {}

  /** OWNER/ADMIN only; reading the setup is not rate limited. */
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
    const principal = request.principal!;
    const now = Date.now();
    const recent = (this.calls.get(principal.operatorId) ?? []).filter(
      (at) => now - at < 60_000,
    );
    if (recent.length >= 10) throw refuse('RATE_LIMITED');
    recent.push(now);
    this.calls.set(principal.operatorId, recent);
    return who;
  }

  private async account(tenantId: string, id: string): Promise<ChannelAccount> {
    const account = await this.prisma.channelAccount.findFirst({
      where: { id, tenantId, channelType: 'instagram' },
    });
    if (!account)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Not found',
        i18nKey: 'errors.notFound',
      });
    return account;
  }

  /** Runs a Meta call and maps its failure to the API's own codes. */
  private async meta<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof InstagramApiError)
        throw refuse(
          error.kind === 'temporary' || error.kind === 'rate_limited'
            ? 'INSTAGRAM_UNREACHABLE'
            : 'INSTAGRAM_REJECTED',
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

  private async credential(
    tenantId: string,
    id: string,
  ): Promise<InstagramCredential> {
    let credential: InstagramCredential | undefined;
    try {
      credential = await readInstagramCredential(this.secrets, {
        tenantId,
        channelAccountId: id,
      });
    } catch (error) {
      if (error instanceof SecretsNotConfiguredError)
        throw refuse('SECRETS_NOT_CONFIGURED');
      credential = undefined; // unreadable counts as missing; reconnect
    }
    if (!credential) throw refuse('NOT_CONNECTED');
    return credential;
  }

  @Post()
  async connect(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<ChannelAccountSummary> {
    const who = this.admit(request);
    if (!this.secrets.configured) throw refuse('SECRETS_NOT_CONFIGURED');
    const parsed = ConnectBody.safeParse(body);
    if (!parsed.success) throw refuse('INVALID_BODY');
    const token = parsed.data.accessToken;
    const me = await this.meta(() => this.graph.me(token));
    return this.save(who, me, token, 'token');
  }

  /** Whether "Continue with Instagram" can work on this server. */
  @Get('oauth')
  setup(@Req() request: InboxRequest): { oauth: boolean } {
    this.manager(request);
    return { oauth: this.oauth.configured };
  }

  /** The Instagram authorization URL, with a state bound to this session. */
  @Post('oauth/start')
  start(@Req() request: InboxRequest): { url: string } {
    const who = this.admit(request);
    if (!this.oauth.configured) throw refuse('OAUTH_NOT_CONFIGURED');
    return { url: this.oauth.authorizeUrl(this.oauth.state(who)) };
  }

  /**
   * Finishes Unified login: the web callback page posts Meta's `code` and the
   * `state` back from the same session (the session cookie is
   * SameSite=Strict, so Meta's redirect itself carries none). The state is
   * checked (sealed, this tenant, operator and session, not expired) and then
   * spent once, before Meta is called.
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
    const { token, accounts } = await this.meta(() =>
      this.oauth.exchange(parsed.data.code),
    );
    // The client picks the account in Meta's dialog; tezda never guesses.
    if (accounts.length === 0) throw refuse('NO_INSTAGRAM_ACCOUNT');
    if (accounts.length > 1) throw refuse('SEVERAL_INSTAGRAM_ACCOUNTS');
    const account = accounts[0]!;
    return this.save(
      who,
      { userId: account.igUserId, username: account.username },
      token,
      'oauth',
    );
  }

  /**
   * Stores the account and its token. A reconnect with the other kind of
   * token removes the old one, so the sender never picks a stale credential.
   */
  private async save(
    who: { tenantId: string; operatorId: string },
    me: { readonly userId: string; readonly username: string | null },
    token: string,
    via: Via,
  ): Promise<ChannelAccountSummary> {
    const existing = await this.prisma.channelAccount.findUnique({
      where: {
        channelType_externalAccountId: {
          channelType: 'instagram',
          externalAccountId: me.userId,
        },
      },
      select: { id: true, tenantId: true },
    });
    // Another tenant's account: refuse without saying whose.
    if (existing && existing.tenantId !== who.tenantId)
      throw refuse('ALREADY_CONNECTED');
    const displayName = me.username ? `@${me.username}` : null;
    const id = await this.prisma.$transaction(async (tx) => {
      const row =
        existing ??
        (await tx.channelAccount.create({
          data: {
            tenantId: who.tenantId,
            channelType: 'instagram',
            externalAccountId: me.userId,
            displayName,
            status: 'DISABLED',
          },
          select: { id: true },
        }));
      if (existing)
        await tx.channelAccount.update({
          where: { id: existing.id },
          data: { displayName },
        });
      return row.id;
    });
    const owner = { tenantId: who.tenantId, channelAccountId: id };
    const [keep, drop] =
      via === 'oauth'
        ? (['instagram_system_user_token', 'instagram_access_token'] as const)
        : (['instagram_access_token', 'instagram_system_user_token'] as const);
    await this.secrets.put(owner, keep, token);
    await this.secrets.delete(owner, drop);
    await this.audit(
      who,
      existing
        ? 'channel.instagram_reconnected'
        : 'channel.instagram_connected',
      id,
      { igUserId: me.userId, via },
    );
    return this.summary(who.tenantId, id);
  }

  /**
   * Subscribes the app to the account's `messages` webhook field, then
   * activates it. Without the app secret no delivery could be verified, so
   * enabling is refused.
   */
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
    const credential = await this.credential(who.tenantId, id);
    await this.meta(() =>
      credential.kind === 'unified'
        ? this.graph.subscribeUnified(
            account.externalAccountId,
            credential.token,
            WEBHOOK_FIELDS,
          )
        : this.graph.subscribe(
            account.externalAccountId,
            credential.token,
            WEBHOOK_FIELDS,
          ),
    );
    await this.prisma.channelAccount.updateMany({
      where: { id, tenantId: who.tenantId },
      data: { status: 'ACTIVE' },
    });
    await this.audit(who, 'channel.instagram_enabled', id, {
      fields: WEBHOOK_FIELDS.join(','),
    });
    return this.summary(who.tenantId, id);
  }

  /**
   * Stops processing: the account is DISABLED and the assistant OFF. Meta's
   * unsubscribe call is not used (not read in the docs); deliveries for a
   * disabled account are refused by the intake.
   */
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
    await this.audit(who, 'channel.instagram_disabled', id);
    return this.summary(who.tenantId, id);
  }
}
