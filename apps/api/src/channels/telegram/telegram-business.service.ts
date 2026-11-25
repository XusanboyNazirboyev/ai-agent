import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../../config/environment.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrivilegedDatabase } from '../../persistence/privileged-database.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import { runWithTenant } from '../../persistence/tenant-context.js';
import { botLanguage, type BotLanguage } from '../../signup/signup-rules.js';
import { channelSlotFree } from '../../webinbox/channel-limit.js';
import { MetaEchoService } from '../meta/meta-echo.service.js';
import {
  businessAccountKey,
  businessLinkKey,
  businessOwnerId,
  readBusinessUpdate,
  tenantFromStart,
} from './telegram-business.js';
import {
  InvalidTelegramUpdateError,
  isPrivateChat,
  normalizeTelegramUpdate,
  type NormalizedTelegramUpdate,
} from './telegram-normalizer.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';

type ReplyKey =
  'linked' | 'linkInvalid' | 'otherBusiness' | 'connected' | 'limit';

const REPLIES: Record<BotLanguage, Record<ReplyKey, string>> = {
  uz: {
    linked:
      'Biznesingiz bog‘landi. Endi Telegram sozlamalarida: Telegram Business → Chatbotlar, shu botni qo‘shing, u javob beradigan chatlarni tanlang va javob berishga ruxsat bering.',
    linkInvalid:
      'Havola eskirgan yoki noto‘g‘ri. Kanallar sahifasida yangi havola oling.',
    otherBusiness:
      'Bu Telegram hisobi boshqa biznesga bog‘langan. Avval u yerda uzing.',
    connected:
      'Telegram Business ulandi. AI agent tanlangan chatlarda AI bot sahifasidagi rejimga ko‘ra javob beradi.',
    limit:
      'Tarifingizdagi kanallar soni to‘lgan, shuning uchun Telegram Business yoqilmadi. Boshqa kanalni o‘chiring yoki tarifni oshiring, keyin botni qayta ulang.',
  },
  ru: {
    linked:
      'Бизнес привязан. Теперь в настройках Telegram: Telegram для бизнеса → Чат-боты, добавьте этого бота, выберите чаты и разрешите ему отвечать.',
    linkInvalid:
      'Ссылка устарела или неверна. Получите новую на странице «Каналы».',
    otherBusiness:
      'Этот аккаунт Telegram привязан к другому бизнесу. Сначала отключите его там.',
    connected:
      'Telegram для бизнеса подключён. AI-агент отвечает в выбранных чатах по режиму на странице AI-бота.',
    limit:
      'Лимит каналов вашего тарифа исчерпан, поэтому Telegram для бизнеса не включён. Отключите другой канал или повысьте тариф, затем подключите бота снова.',
  },
  en: {
    linked:
      'Your business is linked. Now in Telegram settings: Telegram Business → Chatbots, add this bot, choose its chats and allow it to reply.',
    linkInvalid:
      'This link has expired or is wrong. Get a new one on the Channels page.',
    otherBusiness:
      'This Telegram account is linked to another business. Disconnect it there first.',
    connected:
      'Telegram Business is connected. The AI agent answers in the chosen chats in the mode set on the AI bot page.',
    limit:
      'Your plan’s channel limit is reached, so Telegram Business was not switched on. Turn off another channel or upgrade, then connect the bot again.',
  },
};

export type BusinessReply = { chatId: string; text: string };

/**
 * ADR 092: Telegram Business through the platform bot. Only identifiers are
 * logged; customer text goes nowhere but the ordinary Telegram intake.
 */
@Injectable()
export class TelegramBusinessService {
  private readonly logger = new Logger(TelegramBusinessService.name);
  /** Lookups that find the tenant of an update (RLS plan S5). */
  private readonly router: PrismaClient;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly webhook: TelegramWebhookService,
    @Optional() private readonly echoes?: MetaEchoService,
    @Optional() privileged?: PrivilegedDatabase,
  ) {
    this.router = privileged?.db ?? prisma;
  }

  private key(): Buffer | null {
    const master = this.config.get('SECRETS_MASTER_KEY', { infer: true });
    return master ? businessLinkKey(master) : null;
  }

  /**
   * Handles the business part of a platform-bot update. `handled` false means
   * the update is not about Telegram Business (signup takes it).
   */
  async handleUpdate(
    body: unknown,
    now = new Date(),
  ): Promise<{ handled: boolean; reply?: BusinessReply }> {
    const start = this.readStart(body);
    if (start) return { handled: true, reply: await this.link(start, now) };
    const update = readBusinessUpdate(body);
    if (!update) return { handled: false };
    if (update.kind === 'connection') {
      return { handled: true, ...(await this.connection(update)) };
    }
    if (update.kind === 'message') await this.message(body, update);
    return { handled: true };
  }

  private readStart(body: unknown):
    | {
        fromId: string;
        chatId: string;
        text: string;
        language: BotLanguage;
      }
    | undefined {
    const message = (body as { message?: unknown } | null)?.message as
      | {
          text?: unknown;
          chat?: { id?: unknown; type?: unknown };
          from?: { id?: unknown; is_bot?: unknown; language_code?: unknown };
        }
      | undefined;
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    // Exactly `biz` + a 48-character code: signup tokens (43 characters) never match.
    if (!/^\/start(?:@\w+)?\s+biz[A-Za-z0-9_-]{48}$/u.test(text))
      return undefined;
    const fromId = message?.from?.id;
    const chatId = message?.chat?.id;
    if (
      message?.chat?.type !== 'private' ||
      message.from?.is_bot === true ||
      typeof fromId !== 'number' ||
      typeof chatId !== 'number'
    )
      return undefined;
    return {
      fromId: String(fromId),
      chatId: String(chatId),
      text,
      language: botLanguage(
        typeof message.from?.language_code === 'string'
          ? message.from.language_code
          : undefined,
      ),
    };
  }

  /** `/start biz<code>`: the owner's Telegram user becomes the tenant's business account. */
  private async link(
    start: {
      fromId: string;
      chatId: string;
      text: string;
      language: BotLanguage;
    },
    now: Date,
  ): Promise<BusinessReply> {
    const say = (key: ReplyKey): BusinessReply => ({
      chatId: start.chatId,
      text: REPLIES[start.language][key],
    });
    const key = this.key();
    const tenantId = key ? tenantFromStart(key, start.text, now) : null;
    if (!tenantId) return say('linkInvalid');
    const externalAccountId = businessAccountKey(start.fromId);
    const existing = await this.router.channelAccount.findUnique({
      where: {
        channelType_externalAccountId: {
          channelType: 'telegram',
          externalAccountId,
        },
      },
      select: { tenantId: true },
    });
    if (existing && existing.tenantId !== tenantId) return say('otherBusiness');
    if (!existing) {
      await runWithTenant(tenantId, () =>
        this.prisma.$transaction(async (tx) => {
          const account = await tx.channelAccount.create({
            data: {
              tenantId,
              channelType: 'telegram',
              externalAccountId,
              displayName: 'Telegram Business',
              status: 'DISABLED',
            },
            select: { id: true },
          });
          await tx.auditEvent.create({
            data: {
              tenantId,
              actorType: 'SYSTEM',
              actorId: 'platform-bot',
              action: 'channel.telegram_business_linked',
              entityType: 'channel_account',
              entityId: account.id,
              safeInputSummary: { via: 'consent_link' },
            },
          });
        }),
      );
    }
    return say('linked');
  }

  private async connection(update: {
    connectionId: string;
    ownerId: string;
    languageCode: string | undefined;
    active: boolean;
  }): Promise<{ reply?: BusinessReply }> {
    const account = await this.router.channelAccount.findUnique({
      where: {
        channelType_externalAccountId: {
          channelType: 'telegram',
          externalAccountId: businessAccountKey(update.ownerId),
        },
      },
      select: { id: true, tenantId: true, status: true },
    });
    if (!account) {
      this.logger.warn(
        JSON.stringify({ event: 'telegram_business.connection_unlinked' }),
      );
      return {};
    }
    const status = await runWithTenant(account.tenantId, () =>
      this.prisma.$transaction(async (tx) => {
        // Same lock as activateChannelAccount: one free slot, one winner.
        await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`agentcore:channels:${account.tenantId}`}, 0))) AS lock_result`;
        // The plan's channel limit applies as on every other channel.
        const status =
          update.active &&
          (await channelSlotFree(tx, account.tenantId, account.id))
            ? 'ACTIVE'
            : 'DISABLED';
        await tx.channelAccount.update({
          where: { id: account.id },
          data: { businessConnectionId: update.connectionId, status },
        });
        await tx.auditEvent.create({
          data: {
            tenantId: account.tenantId,
            actorType: 'SYSTEM',
            actorId: 'platform-bot',
            action: 'channel.telegram_business_connection',
            entityType: 'channel_account',
            entityId: account.id,
            safeInputSummary: { status, enabled: update.active },
          },
        });
        return status;
      }),
    );
    const texts = REPLIES[botLanguage(update.languageCode)];
    if (update.active && status !== 'ACTIVE')
      return { reply: { chatId: update.ownerId, text: texts.limit } };
    return status === 'ACTIVE' && account.status !== 'ACTIVE'
      ? { reply: { chatId: update.ownerId, text: texts.connected } }
      : {};
  }

  private async message(
    body: unknown,
    update: {
      connectionId: string;
      fromId: string | undefined;
      automatic: boolean;
      chatId: string;
      messageId: string;
      text: string;
      message: Record<string, unknown>;
    },
  ): Promise<void> {
    const account = await this.router.channelAccount.findUnique({
      where: { businessConnectionId: update.connectionId },
      select: {
        id: true,
        tenantId: true,
        status: true,
        externalAccountId: true,
      },
    });
    if (!account || account.status !== 'ACTIVE') return;
    // A message without a sender cannot be told apart from the owner's.
    if (update.fromId === undefined) return;
    if (update.fromId === businessOwnerId(account.externalAccountId)) {
      // The owner answered by hand: the bot steps back (ADR 088). Messages
      // the bot sent, and away/greeting messages, are not the owner typing.
      if (update.automatic || !this.echoes) return;
      await this.echoes.process(account.tenantId, {
        channelAccountId: account.id,
        customerId: update.chatId,
        mid: update.messageId,
        text: update.text,
      });
      return;
    }
    let normalized: NormalizedTelegramUpdate;
    try {
      normalized = normalizeTelegramUpdate({
        update_id: (body as { update_id?: unknown }).update_id,
        message: update.message,
      });
    } catch (error) {
      if (error instanceof InvalidTelegramUpdateError) return;
      throw error;
    }
    if (normalized.kind !== 'text' || !isPrivateChat(normalized)) return;
    await runWithTenant(account.tenantId, () =>
      this.webhook.accept(account.id, normalized),
    );
  }
}
