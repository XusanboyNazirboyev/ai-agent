import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../persistence/prisma.service.js';
import { ChannelSecretStore } from '../../secrets/channel-secret-store.js';
import {
  readInstagramCredential,
  type InstagramCredential,
} from './instagram-credential.js';
import {
  genericTemplateMessage,
  type CarouselSpec,
} from './instagram-carousel.js';
import { InstagramGraphClient } from './instagram-graph.js';

/** No usable access token for the account: connect it again from the web. */
export class InstagramNotConfiguredError extends Error {
  constructor() {
    super('Instagram account has no usable access token');
    this.name = 'InstagramNotConfiguredError';
  }
}

/**
 * ADR 043: comment replies are implemented only for Unified login accounts;
 * the pasted-token (Instagram Login) variant is not documented to us.
 */
export class InstagramCommentReplyUnsupportedError extends Error {
  constructor() {
    super('Comment replies need a Unified login account');
    this.name = 'InstagramCommentReplyUnsupportedError';
  }
}

/**
 * Sends to an Instagram customer as one connected professional account. The
 * account's token (a Unified login system-user token, or a pasted Instagram
 * User access token) lives only in the encrypted channel secret store
 * (ADR 028, purposes `instagram_system_user_token` and
 * `instagram_access_token`); it is read per
 * send, never cached, returned or logged. Tenant scope comes from the stored
 * account, never from the caller.
 */
@Injectable()
export class InstagramSender {
  private readonly logger = new Logger(InstagramSender.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: InstagramGraphClient,
    @Optional() private readonly secrets?: ChannelSecretStore,
  ) {}

  private async account(
    tenantId: string,
    channelAccountId: string,
  ): Promise<{ igUserId: string; credential: InstagramCredential }> {
    const account = await this.prisma.channelAccount.findFirst({
      where: { id: channelAccountId, tenantId, channelType: 'instagram' },
      select: { externalAccountId: true },
    });
    if (!account || !this.secrets?.configured)
      throw new InstagramNotConfiguredError();
    let credential: InstagramCredential | undefined;
    try {
      credential = await readInstagramCredential(this.secrets, {
        tenantId,
        channelAccountId,
      });
    } catch {
      this.logger.error(
        JSON.stringify({
          event: 'instagram.secret_unreadable',
          channelAccountId,
        }),
      );
    }
    if (!credential) throw new InstagramNotConfiguredError();
    return { igUserId: account.externalAccountId, credential };
  }

  /** The customer's display name, or null (see InstagramGraphClient.customerName). */
  async customerName(
    tenantId: string,
    channelAccountId: string,
    igsid: string,
  ): Promise<string | null> {
    const { credential } = await this.account(tenantId, channelAccountId);
    return this.graph.customerName(
      igsid,
      credential.token,
      credential.kind === 'unified' ? 'facebook' : 'instagram',
    );
  }

  async sendText(
    tenantId: string,
    channelAccountId: string,
    recipientId: string,
    text: string,
  ): Promise<{ readonly messageId: string }> {
    const { igUserId, credential } = await this.account(
      tenantId,
      channelAccountId,
    );
    return credential.kind === 'unified'
      ? this.graph.sendTextUnified(
          igUserId,
          credential.token,
          recipientId,
          text,
        )
      : this.graph.sendText(igUserId, credential.token, recipientId, text);
  }

  /** ADR 044: the carousel that follows a text reply listing items. */
  async sendCarousel(
    tenantId: string,
    channelAccountId: string,
    recipientId: string,
    spec: CarouselSpec,
  ): Promise<{ readonly messageId: string }> {
    const { igUserId, credential } = await this.account(
      tenantId,
      channelAccountId,
    );
    return this.graph.sendTemplate(
      igUserId,
      credential.token,
      recipientId,
      genericTemplateMessage(spec),
      credential.kind === 'unified' ? 'unified' : 'instagram',
    );
  }

  /** ADR 043: the one private reply to a public comment. */
  async sendPrivateReply(
    tenantId: string,
    channelAccountId: string,
    commentId: string,
    text: string,
  ): Promise<{ readonly messageId: string }> {
    const { igUserId, credential } = await this.account(
      tenantId,
      channelAccountId,
    );
    if (credential.kind !== 'unified')
      throw new InstagramCommentReplyUnsupportedError();
    return this.graph.sendPrivateReplyUnified(
      igUserId,
      credential.token,
      commentId,
      text,
    );
  }

  /** ADR 043: a short public reply under the comment (template text only). */
  async replyToComment(
    tenantId: string,
    channelAccountId: string,
    commentId: string,
    text: string,
  ): Promise<{ readonly messageId: string }> {
    const { credential } = await this.account(tenantId, channelAccountId);
    if (credential.kind !== 'unified')
      throw new InstagramCommentReplyUnsupportedError();
    return this.graph.replyToCommentUnified(credential.token, commentId, text);
  }
}
