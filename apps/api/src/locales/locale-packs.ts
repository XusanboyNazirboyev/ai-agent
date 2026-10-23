import type { LocalePack } from '../core/locales/locale-pack.js';

/**
 * Initial customer locales. All are `beta` with `nativeReviewed: false`:
 * the wording was written for this implementation and has not been reviewed
 * by native speakers, and the D18 eval threshold has not been measured with a
 * live model. Promote a locale only after both happen.
 *
 * Uzbek uses the respectful "siz" form throughout. The Cyrillic pack was
 * transliterated from the Latin text with the shared transliterator and
 * checked by hand; it still needs native review like the others.
 */

const forbiddenUz = [
  'chegirma',
  'skidka',
  'kafolat',
  'bepul',
  'tekin',
  'aksiya',
];
const forbiddenUzCyrl = [
  'чегирма',
  'скидк',
  'кафолат',
  'бепул',
  'текин',
  'акция',
];

export const UZ_LATN: LocalePack = {
  id: 'uz-Latn',
  language: 'uz',
  script: 'Latn',
  status: 'beta',
  nativeReviewed: false,
  intlLocale: 'uz-Latn-UZ',
  promptName: 'Uzbek in Latin script',
  toneGuidance:
    "Use polite, formal Uzbek with the 'siz' form. Use the Latin alphabet with oʻ and gʻ; never switch to Cyrillic. Keep messages short and warm.",
  templates: {
    greeting: 'Assalomu alaykum! Sizga qanday yordam bera olaman?',
    error:
      "Kechirasiz, hozir so'rovingizga javob bera olmadim. Iltimos, birozdan so'ng qayta yozing yoki operator bilan bog'lanishni xohlasangiz, ayting.",
    noResults: "Kechirasiz, so'rovingiz bo'yicha mos variant topilmadi.",
    offerOperator: 'Xohlasangiz, savolingizni operatorga yetkazaman.',
    optionsIntro: 'Sizga mos variantlar:',
    notUnderstood: "Kechirasiz, javobingizni to'liq tushunmadim.",
    handover: {
      CUSTOMER_REQUEST:
        "Albatta, sizni operator bilan bog'layman. Tez orada javob berishadi.",
      COMPLAINT:
        "Noqulaylik uchun uzr so'raymiz. Murojaatingizni operatorga yetkazaman, tez orada siz bilan bog'lanishadi.",
      NEGOTIATION:
        "Narx va to'lov shartlari bo'yicha kelishuvlarni operatorimiz hal qiladi. Sizni operator bilan bog'layman.",
      AUTH_REQUIRED:
        "Shaxsiy ma'lumotlar bo'yicha savollarga xavfsizlik uchun operator javob beradi. Sizni operator bilan bog'layman.",
      NO_DATA:
        "Hozircha bu ma'lumotni tekshira olmayapman. Savolingizni operatorga yetkazaman.",
      GUARDRAIL:
        "Bu savolga aniq javob berish uchun sizni operator bilan bog'layman.",
      BUDGET_EXHAUSTED:
        "Savolingizni operatorga yo'naltiraman, tez orada javob berishadi.",
      LOW_LANG_CONFIDENCE:
        "Savolingizni to'g'ri tushunishim uchun sizni operator bilan bog'layman.",
    },
    labels: {
      price: 'narxi',
      seats: "bo'sh o'rinlar",
      starts: 'boshlanishi',
      availability: 'holati',
    },
    availability: {
      AVAILABLE: 'joy bor',
      LIMITED: 'joy kam qoldi',
      SOLD_OUT: 'joy qolmagan',
      UNKNOWN: 'aniqlanmagan',
    },
  },
  forbiddenClaimStems: forbiddenUz,
};

export const UZ_CYRL: LocalePack = {
  id: 'uz-Cyrl',
  language: 'uz',
  script: 'Cyrl',
  status: 'beta',
  nativeReviewed: false,
  intlLocale: 'uz-Cyrl-UZ',
  promptName: 'Uzbek in Cyrillic script',
  toneGuidance:
    "Use polite, formal Uzbek with the 'сиз' form. Use the Uzbek Cyrillic alphabet (ў, қ, ғ, ҳ); never switch to Latin except for product names. Keep messages short and warm.",
  templates: {
    greeting: 'Ассалому алайкум! Сизга қандай ёрдам бера оламан?',
    error:
      'Кечирасиз, ҳозир сўровингизга жавоб бера олмадим. Илтимос, бироздан сўнг қайта ёзинг ёки оператор билан боғланишни хоҳласангиз, айтинг.',
    noResults: 'Кечирасиз, сўровингиз бўйича мос вариант топилмади.',
    offerOperator: 'Хоҳласангиз, саволингизни операторга етказаман.',
    optionsIntro: 'Сизга мос вариантлар:',
    notUnderstood: 'Кечирасиз, жавобингизни тўлиқ тушунмадим.',
    handover: {
      CUSTOMER_REQUEST:
        'Албатта, сизни оператор билан боғлайман. Тез орада жавоб беришади.',
      COMPLAINT:
        'Ноқулайлик учун узр сўраймиз. Мурожаатингизни операторга етказаман, тез орада сиз билан боғланишади.',
      NEGOTIATION:
        'Нарх ва тўлов шартлари бўйича келишувларни операторимиз ҳал қилади. Сизни оператор билан боғлайман.',
      AUTH_REQUIRED:
        'Шахсий маълумотлар бўйича саволларга хавфсизлик учун оператор жавоб беради. Сизни оператор билан боғлайман.',
      NO_DATA:
        'Ҳозирча бу маълумотни текшира олмаяпман. Саволингизни операторга етказаман.',
      GUARDRAIL:
        'Бу саволга аниқ жавоб бериш учун сизни оператор билан боғлайман.',
      BUDGET_EXHAUSTED:
        'Саволингизни операторга йўналтираман, тез орада жавоб беришади.',
      LOW_LANG_CONFIDENCE:
        'Саволингизни тўғри тушунишим учун сизни оператор билан боғлайман.',
    },
    labels: {
      price: 'нархи',
      seats: 'бўш ўринлар',
      starts: 'бошланиши',
      availability: 'ҳолати',
    },
    availability: {
      AVAILABLE: 'жой бор',
      LIMITED: 'жой кам қолди',
      SOLD_OUT: 'жой қолмаган',
      UNKNOWN: 'аниқланмаган',
    },
  },
  forbiddenClaimStems: forbiddenUzCyrl,
};

export const RU: LocalePack = {
  id: 'ru',
  language: 'ru',
  script: 'Cyrl',
  status: 'beta',
  nativeReviewed: false,
  intlLocale: 'ru-RU',
  promptName: 'Russian',
  toneGuidance:
    'Use polite Russian with «вы». Keep messages short, friendly and professional.',
  templates: {
    greeting: 'Здравствуйте! Чем могу помочь?',
    error:
      'Извините, сейчас не удалось ответить на ваш запрос. Пожалуйста, напишите чуть позже или сообщите, если хотите связаться с оператором.',
    noResults:
      'К сожалению, по вашему запросу подходящих вариантов не найдено.',
    offerOperator: 'Если хотите, я передам ваш вопрос оператору.',
    optionsIntro: 'Подходящие варианты:',
    notUnderstood: 'Извините, я не совсем понял ваш ответ.',
    handover: {
      CUSTOMER_REQUEST:
        'Конечно, я соединю вас с оператором. Он скоро ответит.',
      COMPLAINT:
        'Приносим извинения за неудобства. Я передам ваше обращение оператору, он скоро с вами свяжется.',
      NEGOTIATION:
        'Вопросы условий и оплаты решает наш оператор. Я соединю вас с ним.',
      AUTH_REQUIRED:
        'Вопросы о личных данных из соображений безопасности решает оператор. Я соединю вас с ним.',
      NO_DATA:
        'Сейчас я не могу проверить эту информацию. Я передам ваш вопрос оператору.',
      GUARDRAIL: 'Чтобы ответить точно, я соединю вас с оператором.',
      BUDGET_EXHAUSTED: 'Я передам ваш вопрос оператору, он скоро ответит.',
      LOW_LANG_CONFIDENCE:
        'Чтобы правильно понять ваш вопрос, я соединю вас с оператором.',
    },
    labels: {
      price: 'стоимость',
      seats: 'свободных мест',
      starts: 'начало',
      availability: 'наличие',
    },
    availability: {
      AVAILABLE: 'места есть',
      LIMITED: 'мест осталось мало',
      SOLD_OUT: 'мест нет',
      UNKNOWN: 'не определено',
    },
  },
  forbiddenClaimStems: ['скидк', 'гарант', 'бесплатн', 'акци', 'подар'],
};

export const EN: LocalePack = {
  id: 'en',
  language: 'en',
  script: 'Latn',
  status: 'beta',
  nativeReviewed: false,
  intlLocale: 'en-US',
  promptName: 'English',
  toneGuidance: 'Use polite, concise, friendly English.',
  templates: {
    greeting: 'Hello! How can I help you?',
    error:
      "Sorry, I couldn't answer your request just now. Please write again shortly, or tell me if you'd like to talk to an operator.",
    noResults: 'Sorry, I could not find a matching option for your request.',
    offerOperator: 'If you like, I can pass your question to an operator.',
    optionsIntro: 'Here are matching options:',
    notUnderstood: "Sorry, I didn't quite understand your answer.",
    handover: {
      CUSTOMER_REQUEST:
        "Of course, I'll connect you with an operator. They will reply shortly.",
      COMPLAINT:
        "We're sorry for the inconvenience. I'll pass your message to an operator, who will contact you shortly.",
      NEGOTIATION:
        "Our operator handles pricing terms and payment questions. I'll connect you.",
      AUTH_REQUIRED:
        "For security, an operator answers questions about personal accounts. I'll connect you.",
      NO_DATA:
        "I can't check that information right now. I'll pass your question to an operator.",
      GUARDRAIL:
        "To give you an accurate answer, I'll connect you with an operator.",
      BUDGET_EXHAUSTED:
        "I'll pass your question to an operator, who will reply shortly.",
      LOW_LANG_CONFIDENCE:
        "To make sure I understand you correctly, I'll connect you with an operator.",
    },
    labels: {
      price: 'price',
      seats: 'seats left',
      starts: 'starts',
      availability: 'availability',
    },
    availability: {
      AVAILABLE: 'available',
      LIMITED: 'few places left',
      SOLD_OUT: 'sold out',
      UNKNOWN: 'unknown',
    },
  },
  forbiddenClaimStems: [
    'discount',
    'guarantee',
    'free of charge',
    'for free',
    'promo',
  ],
};

export const INITIAL_LOCALE_PACKS: readonly LocalePack[] = [
  UZ_LATN,
  UZ_CYRL,
  RU,
  EN,
];
