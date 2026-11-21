import { createHash, timingSafeEqual } from 'node:crypto';

/** Official production checkout; the sandbox uses https://test.paycom.uz. */
export const PAYME_CHECKOUT_URL = 'https://checkout.paycom.uz';
export const PAYME_TRANSACTION_TIMEOUT_MS = 43_200_000;

export const PAYME_ERROR = {
  INTERNAL: -32400,
  HTTP_METHOD: -32300,
  AUTH: -32504,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  PARSE: -32700,
  INVALID_AMOUNT: -31001,
  TRANSACTION_NOT_FOUND: -31003,
  UNABLE: -31008,
  ACCOUNT_NOT_FOUND: -31050,
} as const;

export type PaymeErrorCode = (typeof PAYME_ERROR)[keyof typeof PAYME_ERROR];

const MESSAGES: Record<PaymeErrorCode, { ru: string; uz: string; en: string }> =
  {
    [PAYME_ERROR.HTTP_METHOD]: {
      ru: 'Метод должен быть POST',
      uz: 'HTTP metodi POST bo‘lishi kerak',
      en: 'HTTP method must be POST',
    },
    [PAYME_ERROR.INTERNAL]: {
      ru: 'Внутренняя ошибка',
      uz: 'Ichki xato',
      en: 'Internal error',
    },
    [PAYME_ERROR.AUTH]: {
      ru: 'Недостаточно привилегий',
      uz: 'Ruxsat yetarli emas',
      en: 'Insufficient privilege',
    },
    [PAYME_ERROR.INVALID_REQUEST]: {
      ru: 'Неверный запрос',
      uz: 'Noto‘g‘ri so‘rov',
      en: 'Invalid request',
    },
    [PAYME_ERROR.METHOD_NOT_FOUND]: {
      ru: 'Метод не найден',
      uz: 'Metod topilmadi',
      en: 'Method not found',
    },
    [PAYME_ERROR.PARSE]: {
      ru: 'Ошибка разбора JSON',
      uz: 'JSON o‘qish xatosi',
      en: 'JSON parse error',
    },
    [PAYME_ERROR.INVALID_AMOUNT]: {
      ru: 'Неверная сумма',
      uz: 'Summa noto‘g‘ri',
      en: 'Invalid amount',
    },
    [PAYME_ERROR.TRANSACTION_NOT_FOUND]: {
      ru: 'Транзакция не найдена',
      uz: 'Tranzaksiya topilmadi',
      en: 'Transaction not found',
    },
    [PAYME_ERROR.UNABLE]: {
      ru: 'Операцию выполнить нельзя',
      uz: 'Amalni bajarib bo‘lmaydi',
      en: 'Unable to perform operation',
    },
    [PAYME_ERROR.ACCOUNT_NOT_FOUND]: {
      ru: 'Заказ не найден',
      uz: 'Buyurtma topilmadi',
      en: 'Order not found',
    },
  };

export interface PaymeError {
  readonly code: PaymeErrorCode;
  readonly message: {
    readonly ru: string;
    readonly uz: string;
    readonly en: string;
  };
  readonly data?: string;
}

export function paymeError(code: PaymeErrorCode, data?: string): PaymeError {
  return { code, message: MESSAGES[code], ...(data ? { data } : {}) };
}

function equalText(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

/** Merchant API Basic authentication (login and key are never logged). */
export function paymeAuthorizationMatches(
  authorization: string | undefined,
  login: string,
  key: string,
): boolean {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/u.exec(
    authorization?.trim() ?? '',
  );
  if (!match) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const loginMatches = equalText(decoded.slice(0, separator), login);
  const keyMatches = equalText(decoded.slice(separator + 1), key);
  return loginMatches && keyMatches;
}

export function buildPaymeCheckoutLink(input: {
  merchantId: string;
  paymentId: string;
  amountMinor: bigint;
  locale: 'en' | 'ru' | 'uz';
  returnUrl: string;
}): string {
  const params = [
    `m=${input.merchantId}`,
    `ac.order_id=${input.paymentId}`,
    `a=${input.amountMinor.toString()}`,
    `l=${input.locale}`,
    `c=${input.returnUrl}`,
    'ct=15000',
    'cr=0',
  ].join(';');
  return `${PAYME_CHECKOUT_URL}/${Buffer.from(params, 'utf8').toString('base64')}`;
}
