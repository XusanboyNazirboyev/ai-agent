import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import {
  LocaleRegistry,
  type LocalePack,
} from '../../core/locales/locale-pack.js';
import { INITIAL_LOCALE_PACKS } from '../../locales/locale-packs.js';
import { storedMetaId } from '../meta/meta-event-key.js';
import {
  InstagramAmbiguousSendError,
  InstagramApiError,
} from './instagram-graph.js';
import {
  InstagramCommentReplyUnsupportedError,
  InstagramNotConfiguredError,
  InstagramSender,
} from './instagram-sender.js';
import { splitInstagramText } from './instagram-text.js';

/** Private replies are allowed within 7 days of the comment (Meta docs). */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Outbox event that posts the public template reply under a comment. */
export const COMMENT_PUBLIC_REPLY_EVENT = 'instagram.comment_reply';

export type PrivateReplyResult = 'not_a_comment' | 'handled' | 'sent';

/**
 * ADR 043: answering a public Instagram comment. The answer to the comment
 * (agent or operator) goes out as the one allowed private reply; after it is
 * delivered, a short code-written template is posted under the comment. The
 * same "never resend an ambiguous send" rules as direct messages apply.
 */
@Injectable()
export class InstagramCommentReplyService {
  private readonly logger = new Logger(InstagramCommentReplyService.name);
  private readonly locales = new LocaleRegistry(INITIAL_LOCALE_PACKS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: InstagramSender,
  ) {}

  /**
   * Sends the outbound message as a comment's private reply when it is bound
   * to one: a bot reply is bound at commit to the comment its turn answered;
   * an operator reply takes the latest unanswered comment when that is the
   * customer's latest message. Returns `not_a_comment` when the normal
   * direct-message path applies.
   */
  async trySendPrivateReply(
    tenantId: string,
    messageId: string,
    now: Date = new Date(),
  ): Promise<PrivateReplyResult> {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, tenantId, direction: 'OUTBOUND' },
      select: {
        id: true,
        text: true,
        sequence: true,
        authorType: true,
        conversationId: true,
        channelAccountId: true,
      },
    });
    if (!message) return 'not_a_comment';
    const select = {
      id: true,
      commentId: true,
      commentedAt: true,
    } as const;
    let comment = await this.prisma.instagramComment.findFirst({
      where: { tenantId, privateReplyMessageId: message.id },
      select,
    });
    if (!comment && message.authorType === 'OPERATOR') {
      const latestInbound = await this.prisma.message.findFirst({
        where: {
          tenantId,
          conversationId: message.conversationId,
          direction: 'INBOUND',
          sequence: { lt: message.sequence },
        },
        orderBy: { sequence: 'desc' },
        select: { id: true, type: true },
      });
      if (latestInbound?.type === 'COMMENT') {
        // Reserve the comment's one private reply for this message.
        const reserved = await this.prisma.instagramComment.updateMany({
          where: {
            tenantId,
            messageId: latestInbound.id,
            privateReplyMessageId: null,
          },
          data: { privateReplyMessageId: message.id },
        });
        if (reserved.count === 1)
          comment = await this.prisma.instagramComment.findFirst({
            where: { tenantId, privateReplyMessageId: message.id },
            select,
          });
      }
    }
    // Otherwise only a direct message (inside the customer's own 24-hour
    // window) can reach the customer.
    if (!comment) return 'not_a_comment';

    if (
      now.getTime() - comment.commentedAt.getTime() >
      PRIVATE_REPLY_WINDOW_MS
    ) {
      await this.fail(
        tenantId,
        message.id,
        comment.id,
        'instagram_comment_window_closed',
        'PENDING',
      );
      return 'handled';
    }
    const parts = splitInstagramText(message.text);
    if (parts.length !== 1) {
      // Only one message may be sent: a reply longer than one Instagram
      // message is not cut; an operator answers instead.
      await this.fail(
        tenantId,
        message.id,
        comment.id,
        parts.length === 0
          ? 'instagram_send_invalid'
          : 'instagram_comment_reply_too_long',
        'PENDING',
      );
      return 'handled';
    }

    const claimed = await this.prisma.message.updateMany({
      where: { id: message.id, tenantId, deliveryState: 'PENDING' },
      data: { deliveryState: 'UNKNOWN', deliveryAttempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return 'handled';

    let sent: { readonly messageId: string };
    try {
      sent = await this.sender.sendPrivateReply(
        tenantId,
        message.channelAccountId,
        comment.commentId,
        parts[0]!,
      );
    } catch (error) {
      if (error instanceof InstagramAmbiguousSendError) {
        // Meta may have delivered it: stay UNKNOWN, never resend blindly.
        await this.prisma.message.updateMany({
          where: { id: message.id, tenantId, deliveryState: 'UNKNOWN' },
          data: { deliveryErrorCode: 'instagram_ambiguous_outcome' },
        });
        return 'handled';
      }
      if (error instanceof InstagramApiError && error.retryable) {
        await this.prisma.message.updateMany({
          where: { id: message.id, tenantId, deliveryState: 'UNKNOWN' },
          data: {
            deliveryState: 'PENDING',
            deliveryErrorCode: `instagram_api_${error.kind}`,
          },
        });
        throw error;
      }
      await this.fail(
        tenantId,
        message.id,
        comment.id,
        error instanceof InstagramApiError
          ? `instagram_api_${error.kind}`
          : error instanceof InstagramCommentReplyUnsupportedError
            ? 'instagram_comment_unsupported'
            : error instanceof InstagramNotConfiguredError
              ? 'instagram_not_configured'
              : 'instagram_send_invalid',
        'UNKNOWN',
      );
      return 'handled';
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.message.updateMany({
        where: { id: message.id, tenantId, deliveryState: 'UNKNOWN' },
        data: {
          deliveryState: 'SENT',
          providerMessageId: storedMetaId(sent.messageId),
          deliveryErrorCode: null,
        },
      });
      await tx.instagramComment.updateMany({
        where: { id: comment.id, tenantId },
        data: { status: 'ANSWERED', errorCode: null },
      });
      await tx.outboxEvent.create({
        data: {
          tenantId,
          type: COMMENT_PUBLIC_REPLY_EVENT,
          aggregateType: 'instagram_comment',
          aggregateId: comment.id,
          idempotencyKey: `${COMMENT_PUBLIC_REPLY_EVENT}:${comment.id}`,
          payload: {
            commentRowId: comment.id,
          } satisfies Prisma.InputJsonObject,
        },
      });
    });
    return 'sent';
  }

  /**
   * Posts the locale template under the comment once. A send whose outcome
   * is unknown is never repeated; temporary errors are retried by the queue.
   */
  async publishPublicReply(
    tenantId: string,
    commentRowId: string,
  ): Promise<void> {
    const comment = await this.prisma.instagramComment.findFirst({
      where: { id: commentRowId, tenantId, status: 'ANSWERED' },
      select: {
        id: true,
        commentId: true,
        channelAccountId: true,
        mediaProductType: true,
        privateReplyMessageId: true,
        publicReplyId: true,
        errorCode: true,
        tenant: { select: { defaultLocale: true } },
      },
    });
    if (!comment || comment.publicReplyId !== null) return;
    // Meta: no replies to comments on live video.
    if (comment.mediaProductType?.toUpperCase().includes('LIVE')) return;
    const claimed = await this.prisma.instagramComment.updateMany({
      where: { id: comment.id, tenantId, publicReplyId: null, errorCode: null },
      data: { errorCode: 'public_reply_in_flight' },
    });
    if (claimed.count !== 1) return;

    const text = (await this.localeOf(tenantId, comment)).templates
      .commentPublicReply;
    try {
      const reply = await this.sender.replyToComment(
        tenantId,
        comment.channelAccountId,
        comment.commentId,
        text,
      );
      await this.prisma.instagramComment.updateMany({
        where: { id: comment.id, tenantId },
        data: { publicReplyId: reply.messageId.slice(0, 100), errorCode: null },
      });
    } catch (error) {
      if (error instanceof InstagramApiError && error.retryable) {
        await this.prisma.instagramComment.updateMany({
          where: { id: comment.id, tenantId },
          data: { errorCode: null },
        });
        throw error;
      }
      const code =
        error instanceof InstagramAmbiguousSendError
          ? 'public_reply_ambiguous'
          : error instanceof InstagramApiError
            ? `public_reply_api_${error.kind}`
            : error instanceof InstagramCommentReplyUnsupportedError
              ? 'public_reply_unsupported'
              : 'public_reply_failed';
      await this.prisma.instagramComment.updateMany({
        where: { id: comment.id, tenantId },
        data: { errorCode: code },
      });
      this.logger.warn(
        JSON.stringify({
          event: 'instagram.comment_public_reply_failed',
          code,
        }),
      );
    }
  }

  /** The private reply's language (its agent turn), else the tenant default. */
  private async localeOf(
    tenantId: string,
    comment: {
      readonly privateReplyMessageId: string | null;
      readonly tenant: { readonly defaultLocale: string };
    },
  ): Promise<LocalePack> {
    const turn = comment.privateReplyMessageId
      ? await this.prisma.agentTurn.findFirst({
          where: { tenantId, replyMessageId: comment.privateReplyMessageId },
          select: { locale: true },
        })
      : null;
    for (const candidate of [turn?.locale, comment.tenant.defaultLocale]) {
      if (candidate && this.locales.has(candidate))
        return this.locales.get(candidate);
    }
    return this.locales.get('uz-Latn');
  }

  private async fail(
    tenantId: string,
    messageId: string,
    commentRowId: string,
    code: string,
    from: 'PENDING' | 'UNKNOWN',
  ): Promise<void> {
    await this.prisma.message.updateMany({
      where: { id: messageId, tenantId, deliveryState: from },
      data: { deliveryState: 'FAILED', deliveryErrorCode: code },
    });
    // Nothing reached the customer: the one private reply stays available
    // (an operator can still answer the comment).
    await this.prisma.instagramComment.updateMany({
      where: { id: commentRowId, tenantId, privateReplyMessageId: messageId },
      data: { status: 'FAILED', errorCode: code, privateReplyMessageId: null },
    });
  }
}
