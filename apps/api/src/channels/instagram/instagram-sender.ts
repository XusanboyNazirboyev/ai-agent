import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../persistence/prisma.service.js';
import { ChannelSecretStore } from '../../secrets/channel-secret-store.js';
import { InstagramGraphClient } from './instagram-graph.js';

/** No usable access token for the account: connect it again from the web. */
export class InstagramNotConfiguredError extends Error {
  constructor() {
    super('Instagram account has no usable access token');
    this.name = 'InstagramNotConfiguredError';
  }
}

/**
 * Sends to an Instagram customer as one connected professional account. The
 * account's Instagram User access token lives only in the encrypted channel
 * secret store (ADR 028, purpose `instagram_access_token`); it is read per
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
  ): Promise<{ igUserId: string; token: string }> {
    const account = await this.prisma.channelAccount.findFirst({
      where: { id: channelAccountId, tenantId, channelType: 'instagram' },
      select: { externalAccountId: true },
    });
    if (!account || !this.secrets?.configured)
      throw new InstagramNotConfiguredError();
    let token: string | undefined;
    try {
      token = await this.secrets.get(
        { tenantId, channelAccountId },
        'instagram_access_token',
      );
    } catch {
      this.logger.error(
        JSON.stringify({
          event: 'instagram.secret_unreadable',
          channelAccountId,
        }),
      );
    }
    if (!token) throw new InstagramNotConfiguredError();
    return { igUserId: account.externalAccountId, token };
  }

  async sendText(
    tenantId: string,
    channelAccountId: string,
    recipientId: string,
    text: string,
  ): Promise<{ readonly messageId: string }> {
    const { igUserId, token } = await this.account(tenantId, channelAccountId);
    return this.graph.sendText(igUserId, token, recipientId, text);
  }
}
