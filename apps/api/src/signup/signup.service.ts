import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { INITIAL_LOCALE_PACKS } from '../locales/locale-packs.js';
import { DOMAIN_PACKS } from '../packs/registry.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { normalizeEmail } from '../team/operator-invite.service.js';
import {
  DEFAULT_SESSION_POLICY,
  SESSION_POLICY,
  type SessionPolicy,
} from '../auth/session-policy.js';
import { hashPassword } from '../webinbox/password.js';
import {
  PlatformBotSender,
  type BotReplyMarkup,
} from './platform-bot.sender.js';
import {
  PlatformUpdate,
  TRIAL_DAYS,
  botLanguage,
  botMessage,
  contactIsOwn,
  generateSignupSecret,
  hashSignupSecret,
  normalizePhone,
  plausibleSignupToken,
  signupExpiry,
  slugCandidates,
  startPayload,
  type BotLanguage,
  type BotMessageKey,
} from './signup-rules.js';

export type SignupErrorCode =
  'EMAIL_TAKEN' | 'PLAN_INVALID' | 'SIGNUP_UNAVAILABLE';

export class SignupError extends Error {
  constructor(readonly code: SignupErrorCode) {
    super(code);
    this.name = 'SignupError';
  }
}

export interface CreateSignupInput {
  readonly businessName: string;
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly planCode: string;
}

export interface CreatedSignup {
  readonly id: string;
  readonly telegramUrl: string;
  readonly expiresAt: Date;
  /** Secret that binds this browser to the signup; set as an httpOnly cookie. */
  readonly binding: string;
}

export type SignupStatusView =
  | { status: 'PENDING' | 'EXPIRED' }
  | { status: 'REFUSED'; reason: string | null }
  | {
      status: 'CONFIRMED';
      /** Present once, to the browser that holds the binding secret. */
      session?: { tenantId: string; operatorId: string };
    };

const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 86_400_000);

const TIMEZONE = 'Asia/Tashkent';
const LOCALE_BY_LANGUAGE: Record<BotLanguage, string> = {
  uz: 'uz-Latn',
  ru: 'ru',
  en: 'en',
};

class Refusal extends Error {
  constructor(
    readonly key: BotMessageKey,
    readonly reason: string,
  ) {
    super(reason);
  }
}

function isUnique(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Self-serve signup (ADR 080). Platform level: runs on the privileged
 * connection because no tenant exists yet. Customer text is untrusted: the
 * platform bot reads a few typed fields of an update and nothing else.
 */
@Injectable()
export class SignupService {
  private readonly db: PrismaClient;

  constructor(
    privileged: PrivilegedDatabase,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly bot: PlatformBotSender,
    @Optional()
    @Inject(SESSION_POLICY)
    private readonly policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  ) {
    this.db = privileged.db;
  }

  /** The three env settings together; otherwise signup is unavailable. */
  get configured(): boolean {
    return (
      !!this.config.get('PLATFORM_TELEGRAM_BOT_TOKEN', { infer: true }) &&
      !!this.config.get('PLATFORM_TELEGRAM_BOT_USERNAME', { infer: true }) &&
      !!this.config.get('PLATFORM_TELEGRAM_WEBHOOK_SECRET', { infer: true })
    );
  }

  async create(
    input: CreateSignupInput,
    now = new Date(),
  ): Promise<CreatedSignup> {
    const username = this.config.get('PLATFORM_TELEGRAM_BOT_USERNAME', {
      infer: true,
    });
    if (!this.configured || !username)
      throw new SignupError('SIGNUP_UNAVAILABLE');
    const email = normalizeEmail(input.email);
    if (!email) throw new SignupError('PLAN_INVALID');
    const plan = await this.db.subscriptionPlan.findFirst({
      where: { code: input.planCode, isActive: true },
      select: { id: true },
    });
    if (!plan) throw new SignupError('PLAN_INVALID');
    if (await this.db.operatorCredential.findUnique({ where: { email } }))
      throw new SignupError('EMAIL_TAKEN');
    const token = generateSignupSecret();
    const binding = generateSignupSecret();
    const expiresAt = signupExpiry(now);
    const row = await this.db.pendingSignup.create({
      data: {
        tokenHash: hashSignupSecret(token),
        bindingHash: hashSignupSecret(binding),
        businessName: input.businessName,
        personName: input.name,
        email,
        passwordHash: await hashPassword(input.password, this.policy.scrypt),
        planId: plan.id,
        expiresAt,
      },
      select: { id: true },
    });
    return {
      id: row.id,
      telegramUrl: `https://t.me/${username}?start=${token}`,
      expiresAt,
      binding,
    };
  }

  /**
   * What the signup page polls. Personal data never leaves. When the signup is
   * confirmed and the caller holds the binding secret, the first call returns
   * the operator to sign in (once); later calls answer CONFIRMED alone.
   */
  async status(
    id: string,
    binding: string | undefined,
    now = new Date(),
  ): Promise<SignupStatusView | null> {
    const row = await this.db.pendingSignup.findUnique({ where: { id } });
    if (!row) return null;
    if (row.status === 'PENDING' && row.expiresAt <= now) {
      await this.db.pendingSignup.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      return { status: 'EXPIRED' };
    }
    if (row.status === 'REFUSED')
      return { status: 'REFUSED', reason: row.refusalReason };
    if (row.status !== 'CONFIRMED') return { status: row.status };
    if (!binding || hashSignupSecret(binding) !== row.bindingHash)
      return { status: 'CONFIRMED' };
    const claimed = await this.db.pendingSignup.updateMany({
      where: { id, status: 'CONFIRMED', signedInAt: null },
      data: { signedInAt: now },
    });
    if (claimed.count !== 1 || !row.createdTenantId)
      return { status: 'CONFIRMED' };
    const operator = await this.db.operator.findFirst({
      where: { tenantId: row.createdTenantId, role: 'OWNER' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return operator
      ? {
          status: 'CONFIRMED',
          session: { tenantId: row.createdTenantId, operatorId: operator.id },
        }
      : { status: 'CONFIRMED' };
  }

  /** One Telegram update for the platform bot. Never throws on bad input. */
  async handleUpdate(body: unknown, now = new Date()): Promise<void> {
    const parsed = PlatformUpdate.safeParse(body);
    const message = parsed.success ? parsed.data.message : undefined;
    if (!parsed.success || !message) return;
    if (message.chat.type !== 'private' || message.from.is_bot) return;
    const updateId = parsed.data.update_id;
    const chatId = String(message.chat.id);
    const fromId = String(message.from.id);
    const language = botLanguage(message.from.language_code);
    const say = (
      key: BotMessageKey,
      markup?: BotReplyMarkup,
    ): Promise<boolean> =>
      this.bot.send(chatId, botMessage(language, key), markup);

    if (message.contact) {
      await this.onContact(message.contact, {
        fromNumber: message.from.id,
        fromId,
        chatId,
        updateId,
        language,
        now,
        say,
      });
      return;
    }
    const payload = startPayload(message.text);
    if (payload === null) {
      await say('sendStart');
      return;
    }
    if (!plausibleSignupToken(payload)) {
      await say(payload === '' ? 'sendStart' : 'unknownStart');
      return;
    }
    const signup = await this.db.pendingSignup.findUnique({
      where: { tokenHash: hashSignupSecret(payload) },
    });
    if (!signup) {
      await say('unknownStart');
      return;
    }
    if (signup.status === 'CONFIRMED') {
      await say('done', { remove_keyboard: true });
      return;
    }
    if (signup.status !== 'PENDING' || signup.expiresAt <= now) {
      await say('expired', { remove_keyboard: true });
      return;
    }
    const claimed = await this.claimUpdate(signup.id, updateId, {
      telegramUserId: fromId,
      telegramChatId: chatId,
    });
    if (!claimed) return;
    if (
      await this.db.trialClaim.findUnique({ where: { telegramUserId: fromId } })
    ) {
      await this.refuse(signup.id, 'TRIAL_USED');
      await say('trialUsed', { remove_keyboard: true });
      return;
    }
    await say('askPhone', this.phoneKeyboard(language));
  }

  private phoneKeyboard(language: BotLanguage): BotReplyMarkup {
    return {
      keyboard: [
        [{ text: botMessage(language, 'shareButton'), request_contact: true }],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    };
  }

  /** True when this update id is newer than the last one seen for the signup. */
  private async claimUpdate(
    id: string,
    updateId: number,
    data: Record<string, string> = {},
  ): Promise<boolean> {
    const result = await this.db.pendingSignup.updateMany({
      where: {
        id,
        status: 'PENDING',
        OR: [
          { lastUpdateId: null },
          { lastUpdateId: { lt: BigInt(updateId) } },
        ],
      },
      data: { ...data, lastUpdateId: BigInt(updateId) },
    });
    return result.count === 1;
  }

  private async refuse(id: string, reason: string): Promise<void> {
    await this.db.pendingSignup.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'REFUSED', refusalReason: reason },
    });
  }

  private async onContact(
    contact: { phone_number: string; user_id?: number | undefined },
    ctx: {
      fromNumber: number;
      fromId: string;
      chatId: string;
      updateId: number;
      language: BotLanguage;
      now: Date;
      say: (key: BotMessageKey, markup?: BotReplyMarkup) => Promise<boolean>;
    },
  ): Promise<void> {
    const signup = await this.db.pendingSignup.findFirst({
      where: { telegramUserId: ctx.fromId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (!signup || signup.expiresAt <= ctx.now) {
      await ctx.say('expired', { remove_keyboard: true });
      return;
    }
    const phone = normalizePhone(contact.phone_number);
    if (!phone || !contactIsOwn(ctx.fromNumber, contact)) {
      await ctx.say('foreignContact', this.phoneKeyboard(ctx.language));
      return;
    }
    if (!(await this.claimUpdate(signup.id, ctx.updateId))) return;
    try {
      await this.confirm(signup.id, ctx.fromId, phone, ctx.language, ctx.now);
    } catch (error) {
      if (error instanceof Refusal) {
        await this.refuse(signup.id, error.reason);
        await ctx.say(error.key, { remove_keyboard: true });
        return;
      }
      throw error;
    }
    await ctx.say('done', { remove_keyboard: true });
  }

  /**
   * Tenant, OWNER, trial, claim and audit in one transaction. The unique
   * indexes on `trial_claims` and on credentials are the final word on a
   * second trial or a taken e-mail, whatever raced.
   */
  private async confirm(
    id: string,
    telegramUserId: string,
    phone: string,
    language: BotLanguage,
    now: Date,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.confirmOnce(id, telegramUserId, phone, language, now);
        return;
      } catch (error) {
        if (error instanceof Refusal || !isUnique(error)) throw error;
        // A unique violation: decide by state which rule it was, else retry (slug race).
        if (
          await this.db.trialClaim.findFirst({
            where: { OR: [{ telegramUserId }, { phone }] },
          })
        )
          throw new Refusal('trialUsed', 'TRIAL_USED');
        const row = await this.db.pendingSignup.findUnique({ where: { id } });
        if (
          row &&
          (await this.db.operatorCredential.findUnique({
            where: { email: row.email },
          }))
        )
          throw new Refusal('emailTaken', 'EMAIL_TAKEN');
      }
    }
    throw new Error('signup confirmation did not settle');
  }

  private async confirmOnce(
    id: string,
    telegramUserId: string,
    phone: string,
    language: BotLanguage,
    now: Date,
  ): Promise<void> {
    const signup = await this.db.pendingSignup.findUnique({ where: { id } });
    if (!signup || signup.status !== 'PENDING' || signup.expiresAt <= now)
      throw new Refusal('expired', 'EXPIRED');
    if (
      await this.db.trialClaim.findFirst({
        where: { OR: [{ telegramUserId }, { phone }] },
      })
    )
      throw new Refusal('trialUsed', 'TRIAL_USED');
    if (
      await this.db.operatorCredential.findUnique({
        where: { email: signup.email },
      })
    )
      throw new Refusal('emailTaken', 'EMAIL_TAKEN');
    const plan = await this.db.subscriptionPlan.findFirst({
      where: { id: signup.planId, isActive: true },
    });
    if (!plan) throw new Refusal('unavailable', 'PLAN_INVALID');
    const pack = [...DOMAIN_PACKS.values()][0];
    if (!pack) throw new Refusal('unavailable', 'NO_PACK');
    let slug = '';
    for (const candidate of slugCandidates(signup.businessName)) {
      if (!(await this.db.tenant.findUnique({ where: { slug: candidate } }))) {
        slug = candidate;
        break;
      }
    }
    if (!slug) throw new Error('no free slug');
    await this.db.$transaction(async (tx) => {
      const marked = await tx.pendingSignup.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: 'CONFIRMED',
          telegramUserId,
          phone,
          confirmedAt: now,
        },
      });
      if (marked.count !== 1) throw new Refusal('expired', 'EXPIRED');
      const tenant = await tx.tenant.create({
        data: {
          slug,
          name: signup.businessName,
          defaultLocale: LOCALE_BY_LANGUAGE[language],
          supportedLocales: INITIAL_LOCALE_PACKS.map((locale) => locale.id),
          timezone: TIMEZONE,
          packKey: pack.key,
          packVersion: pack.version,
          config: { billing: { required: true }, selfSignup: true },
        },
      });
      const operator = await tx.operator.create({
        data: {
          tenantId: tenant.id,
          displayName: signup.personName,
          role: 'OWNER',
        },
      });
      await tx.operatorCredential.create({
        data: {
          tenantId: tenant.id,
          operatorId: operator.id,
          email: signup.email,
          passwordHash: signup.passwordHash,
        },
      });
      const subscription = await tx.tenantSubscription.create({
        data: {
          tenantId: tenant.id,
          planId: plan.id,
          status: 'TRIAL',
          currentPeriodStart: now,
          currentPeriodEnd: addDays(now, TRIAL_DAYS),
        },
      });
      await tx.trialClaim.create({
        data: { telegramUserId, phone, tenantId: tenant.id },
      });
      await tx.pendingSignup.update({
        where: { id },
        data: { createdTenantId: tenant.id },
      });
      await tx.platformAuditEvent.create({
        data: {
          actorAdminId: null,
          action: 'tenant.self_signup',
          tenantId: tenant.id,
          entityType: 'tenant',
          entityId: tenant.id,
          safeSummary: {
            slug: tenant.slug,
            planCode: plan.code,
            subscriptionId: subscription.id,
            trialDays: TRIAL_DAYS,
          },
        },
      });
    });
  }
}
