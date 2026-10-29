/**
 * Operator-facing wording for the Telegram group (not customer text). Beta:
 * not reviewed by native speakers, like the customer locale packs. The
 * language follows the tenant's default locale.
 */
export type OperatorLocale = 'en' | 'ru' | 'uz-Latn';

interface Strings {
  handover: string;
  contact: string;
  language: string;
  slots: string;
  lead: string;
  shown: string;
  last: string;
  none: string;
  take: string;
  returnToBot: string;
  close: string;
  reasons: Record<string, string>;
  taken: (name: string) => string;
  alreadyTaken: string;
  forbidden: string;
  illegal: string;
  notAssigned: string;
  done: string;
  duplicate: string;
  replied: string;
  noted: string;
  needReply: string;
  slaAlert: (minutes: number) => string;
  customer: string;
  digestTitle: (date: string) => string;
  digestEmpty: string;
  digestWaiting: (count: number) => string;
  alertBudget: (percent: number, month: string) => string;
  alertCrmFailures: (count: number) => string;
}

const EN: Strings = {
  handover: 'Handover',
  contact: 'Contact',
  language: 'Language',
  slots: 'Collected',
  lead: 'Lead',
  shown: 'Shown to customer',
  last: 'Last messages',
  none: 'none',
  take: 'Take over',
  returnToBot: 'Return to bot',
  close: 'Close',
  reasons: {},
  taken: (name) => `Taken by ${name}`,
  alreadyTaken: 'Already taken by someone else',
  forbidden: 'You are not an active operator of this team',
  illegal: 'Not possible in the current state',
  notAssigned: 'This conversation is assigned to another operator',
  done: 'Done',
  duplicate: 'Already done',
  replied: 'Sent to the customer',
  noted: 'Note saved',
  needReply: 'Reply to the handover message to send text to the customer',
  slaAlert: (minutes) => `Nobody has taken this handover for ${minutes} min`,
  customer: 'Customer',
  digestTitle: (date) => `Morning digest ${date}`,
  digestEmpty: 'No new hot or warm leads.',
  digestWaiting: (count) => `Waiting for an operator: ${count}`,
  alertBudget: (percent, month) =>
    `Alert: ${percent}% of the monthly AI budget is used (${month})`,
  alertCrmFailures: (count) =>
    `Alert: ${count} leads could not be sent to the CRM in the last hour`,
};

const RU: Strings = {
  ...EN,
  handover: 'Передача оператору',
  contact: 'Контакт',
  language: 'Язык',
  slots: 'Собрано',
  lead: 'Лид',
  shown: 'Показано клиенту',
  last: 'Последние сообщения',
  none: 'нет',
  take: 'Взять',
  returnToBot: 'Вернуть боту',
  close: 'Закрыть',
  taken: (name) => `Взял(а): ${name}`,
  alreadyTaken: 'Уже взял другой оператор',
  forbidden: 'Вы не активный оператор этой команды',
  illegal: 'Сейчас это невозможно',
  notAssigned: 'Диалог закреплён за другим оператором',
  done: 'Готово',
  duplicate: 'Уже выполнено',
  replied: 'Отправлено клиенту',
  noted: 'Заметка сохранена',
  needReply: 'Ответьте на сообщение о передаче, чтобы написать клиенту',
  slaAlert: (minutes) => `Передачу никто не взял уже ${minutes} мин`,
  customer: 'Клиент',
  digestTitle: (date) => `Утренняя сводка ${date}`,
  digestEmpty: 'Новых горячих и тёплых лидов нет.',
  digestWaiting: (count) => `Ждут оператора: ${count}`,
  alertBudget: (percent, month) =>
    `Внимание: использовано ${percent}% месячного бюджета ИИ (${month})`,
  alertCrmFailures: (count) =>
    `Внимание: ${count} лидов не удалось передать в CRM за последний час`,
};

const UZ: Strings = {
  ...EN,
  handover: 'Operatorga uzatish',
  contact: 'Mijoz',
  language: 'Til',
  slots: 'Yig‘ilgan',
  lead: 'Lid',
  shown: 'Mijozga ko‘rsatilgan',
  last: 'Oxirgi xabarlar',
  none: 'yo‘q',
  take: 'Olish',
  returnToBot: 'Botga qaytarish',
  close: 'Yopish',
  taken: (name) => `Oldi: ${name}`,
  alreadyTaken: 'Boshqa operator allaqachon oldi',
  forbidden: 'Siz bu jamoaning faol operatori emassiz',
  illegal: 'Hozirgi holatda mumkin emas',
  notAssigned: 'Suhbat boshqa operatorga biriktirilgan',
  done: 'Bajarildi',
  duplicate: 'Allaqachon bajarilgan',
  replied: 'Mijozga yuborildi',
  noted: 'Eslatma saqlandi',
  needReply: 'Mijozga yozish uchun uzatish xabariga javob bering',
  slaAlert: (minutes) => `Uzatishni ${minutes} daqiqadan beri hech kim olmadi`,
  customer: 'Mijoz',
  digestTitle: (date) => `Ertalabki xulosa ${date}`,
  digestEmpty: 'Yangi issiq va iliq lidlar yo\u2018q.',
  digestWaiting: (count) => `Operatorni kutayotganlar: ${count}`,
  alertBudget: (percent, month) =>
    `Diqqat: oylik AI byudjetining ${percent}% ishlatildi (${month})`,
  alertCrmFailures: (count) =>
    `Diqqat: oxirgi bir soatda ${count} ta lid CRMga yuborilmadi`,
};

export function operatorStrings(locale: string): Strings {
  return locale === 'ru' ? RU : locale.startsWith('uz') ? UZ : EN;
}

/** Marker that routes an operator's Telegram reply back to its handover. */
export function refLine(handoverId: string): string {
  return `ref:${handoverId}`;
}

export function parseRef(text: string | undefined): string | undefined {
  const match =
    /ref:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/u.exec(
      text ?? '',
    );
  return match?.[1];
}
