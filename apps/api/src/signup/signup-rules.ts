import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';

/** A pending signup is valid for 30 minutes (ADR 080). */
export const SIGNUP_TTL_MS = 30 * 60 * 1000;
/** The free trial is 3 days, no card (ADR 080 decision 2). */
export const TRIAL_DAYS = 3;

export function signupExpiry(now: Date): Date {
  return new Date(now.getTime() + SIGNUP_TTL_MS);
}

/** 32 random bytes, base64url: appears once, in the Telegram start link. */
export function generateSignupSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSignupSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Telegram allows start payloads of 1-64 chars of A-Z a-z 0-9 _ - (Bot API, deep linking). */
export function plausibleSignupToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{40,60}$/u.test(token);
}

export function constantTimeEqual(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

/** The webhook path secret, derived from the header secret so only one is stored. */
export function platformWebhookPathSecret(headerSecret: string): string {
  return createHmac('sha256', headerSecret)
    .update('platform-telegram-webhook-path')
    .digest('hex')
    .slice(0, 40);
}

const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'j',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sh',
  ъ: '',
  ы: 'i',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  ў: 'u',
  қ: 'q',
  ғ: 'g',
  ҳ: 'h',
};

/** Slug base from a business name: a-z 0-9 and single dashes, at most 60 chars. */
export function slugBase(name: string): string {
  const latin = [...name.toLowerCase().normalize('NFKD')]
    .map((char) => CYRILLIC[char] ?? char)
    .join('')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60)
    .replace(/-+$/u, '');
  return latin || 'business';
}

/** The base first, then suffixed candidates; the caller takes the first free one. */
export function slugCandidates(name: string, attempts = 6): string[] {
  const base = slugBase(name);
  const out = [base];
  for (let i = 1; i < attempts; i += 1)
    out.push(`${base}-${randomBytes(3).toString('hex')}`);
  return out;
}

/** Phone as `+digits` (8 to 15 digits), or undefined. */
export function normalizePhone(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const digits = input.replace(/\D/gu, '');
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : undefined;
}

/** A shared contact counts only when it is the sender's own (Bot API: contact.user_id). */
export function contactIsOwn(
  fromId: number,
  contact: { readonly user_id?: number | undefined },
): boolean {
  return contact.user_id !== undefined && contact.user_id === fromId;
}

export type BotLanguage = 'uz' | 'ru' | 'en';

/** By Telegram `language_code`; default uz. */
export function botLanguage(code: string | undefined): BotLanguage {
  const lower = (code ?? '').toLowerCase();
  if (lower.startsWith('ru')) return 'ru';
  if (lower.startsWith('en')) return 'en';
  return 'uz';
}

export type BotMessageKey =
  | 'askPhone'
  | 'shareButton'
  | 'done'
  | 'foreignContact'
  | 'expired'
  | 'trialUsed'
  | 'emailTaken'
  | 'unknownStart'
  | 'unavailable'
  | 'sendStart';

const MESSAGES: Record<BotLanguage, Record<BotMessageKey, string>> = {
  uz: {
    askPhone:
      'Ro‘yxatdan o‘tishni tasdiqlash uchun pastdagi tugma orqali telefon raqamingizni yuboring.',
    shareButton: 'Telefon raqamni yuborish',
    done: 'Tayyor! Hisobingiz yaratildi. Saytdagi sahifaga qayting, u o‘zi ochiladi.',
    foreignContact:
      'Faqat o‘zingizning raqamingizni yuboring: pastdagi tugmadan foydalaning.',
    expired: 'Havola eskirgan. Saytda ro‘yxatdan o‘tishni qaytadan boshlang.',
    trialUsed:
      'Bu telefon yoki Telegram hisobi bilan bepul sinov allaqachon olingan. Saytda mavjud hisobingiz bilan kiring.',
    emailTaken:
      'Bu e-pochta allaqachon ishlatilgan. Saytda mavjud hisobingiz bilan kiring.',
    unknownStart:
      'Havola topilmadi yoki eskirgan. Saytda ro‘yxatdan o‘tishni qaytadan boshlang.',
    unavailable:
      'Hozir ro‘yxatdan o‘tish ishlamayapti. Keyinroq urinib ko‘ring.',
    sendStart:
      'Ro‘yxatdan o‘tish uchun saytdagi “Telegramda tasdiqlash” tugmasini bosing.',
  },
  ru: {
    askPhone:
      'Чтобы подтвердить регистрацию, отправьте свой номер телефона кнопкой ниже.',
    shareButton: 'Отправить номер телефона',
    done: 'Готово! Аккаунт создан. Вернитесь на страницу сайта, она откроется сама.',
    foreignContact: 'Отправьте только свой номер: используйте кнопку ниже.',
    expired: 'Ссылка устарела. Начните регистрацию на сайте заново.',
    trialUsed:
      'Бесплатный пробный период для этого телефона или аккаунта Telegram уже использован. Войдите на сайте в свой аккаунт.',
    emailTaken:
      'Этот e-mail уже используется. Войдите на сайте в свой аккаунт.',
    unknownStart:
      'Ссылка не найдена или устарела. Начните регистрацию на сайте заново.',
    unavailable: 'Регистрация сейчас недоступна. Попробуйте позже.',
    sendStart:
      'Чтобы зарегистрироваться, нажмите на сайте кнопку «Подтвердить в Telegram».',
  },
  en: {
    askPhone:
      'To confirm your signup, share your phone number with the button below.',
    shareButton: 'Share phone number',
    done: 'Done! Your account is ready. Go back to the page on the website, it opens by itself.',
    foreignContact: 'Please share only your own number: use the button below.',
    expired: 'This link has expired. Start the signup on the website again.',
    trialUsed:
      'The free trial was already used with this phone or Telegram account. Sign in to your account on the website.',
    emailTaken:
      'This e-mail is already in use. Sign in to your account on the website.',
    unknownStart:
      'Link not found or expired. Start the signup on the website again.',
    unavailable: 'Signup is not available right now. Please try again later.',
    sendStart: 'To sign up, press “Confirm in Telegram” on the website.',
  },
};

export function botMessage(language: BotLanguage, key: BotMessageKey): string {
  return MESSAGES[language][key];
}

/** The slice of a Telegram update the platform bot looks at; everything else is dropped. */
export const PlatformUpdate = z.object({
  update_id: z.number().int().nonnegative(),
  message: z
    .object({
      message_id: z.number().int(),
      from: z.object({
        id: z.number().int().positive(),
        is_bot: z.boolean().optional(),
        language_code: z.string().max(20).optional(),
      }),
      chat: z.object({ id: z.number().int(), type: z.string().max(20) }),
      text: z.string().max(4096).optional(),
      contact: z
        .object({
          phone_number: z.string().max(40),
          user_id: z.number().int().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type PlatformUpdate = z.infer<typeof PlatformUpdate>;

/** `/start <token>` (also `/start@bot <token>`); undefined for anything else. */
export function startPayload(text: string | undefined): string | null {
  if (!text) return null;
  const match = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/u.exec(text);
  if (!match) return null;
  return match[1] ?? '';
}
