import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../persistence/prisma.service.js';
import { ChannelSecretStore } from '../../secrets/channel-secret-store.js';
import { InstagramGraphClient } from '../instagram/instagram-graph.js';

/** No usable Page access token for the account: connect the Page again. */
export class FacebookNotConfiguredError extends Error {
  constructor() {
    super('Facebook Page has no usable access token');
    this.name = 'FacebookNotConfiguredError';
  }
}

/**
 * Sends to a Messenger customer as one connected Facebook Page (ADR 040).
 * The Page access token lives only in the encrypted channel secret store
 * (purpose `facebook_page_access_token`); it is read per send, never cached,
 * returned or logged. Tenant scope comes from the stored account.
 */
@Injectable()
export class FacebookSender {
  private readonly logger = new Logger(FacebookSender.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: InstagramGraphClient,
    @Optional() private readonly secrets?: ChannelSecretStore,
  ) {}

  async sendText(
    tenantId: string,
    channelAccountId: string,
    recipientId: string,
    text: string,
  ): Promise<{ readonly messageId: string }> {
    const account = await this.prisma.channelAccount.findFirst({
      where: { id: channelAccountId, tenantId, channelType: 'facebook' },
      select: { externalAccountId: true },
    });
    if (!account || !this.secrets?.configured)
      throw new FacebookNotConfiguredError();
    let token: string | undefined;
    try {
      token = await this.secrets.get(
        { tenantId, channelAccountId },
        'facebook_page_access_token',
      );
    } catch {
      this.logger.error(
        JSON.stringify({
          event: 'facebook.secret_unreadable',
          channelAccountId,
        }),
      );
    }
    if (!token) throw new FacebookNotConfiguredError();
    return this.graph.sendMessengerText(
      account.externalAccountId,
      token,
      recipientId,
      text,
    );
  }
}
