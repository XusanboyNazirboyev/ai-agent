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
 *
 * Handover notices say only that the message was recorded: operator
 * notification is not built yet (Phase 5), so no template may promise a
 * reply time or claim that a person has taken the case.
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
    languageClarification:
      "Iltimos, o'zbek, rus yoki ingliz tilida yozing. / Пожалуйста, пишите на узбекском, русском или английском. / Please write in Uzbek, Russian or English.",
    aiDisclosure:
      "Men avtomatlashtirilgan sun'iy intellekt yordamchisiman. Sizga mos variantni tanlash va dolzarb ma'lumotni tekshirishda yordam bera olaman; istalgan vaqtda xodim bilan bog'lanishni so'rashingiz mumkin.",
    handover: {
      CUSTOMER_REQUEST:
        "Albatta. Xodim bilan bog'lanish haqidagi so'rovingiz saqlandi.",
      COMPLAINT:
        "Noqulaylik uchun uzr so'raymiz. Murojaatingiz jamoamiz uchun saqlandi.",
      NEGOTIATION:
        "Narx shartlari va to'lov masalalarini jamoamiz hal qiladi. So'rovingiz ular uchun saqlandi.",
      AUTH_REQUIRED:
        "Xavfsizlik uchun shaxsiy hisob ma'lumotlarini bu yerda muhokama qila olmayman. Savolingiz jamoamiz uchun saqlandi.",
      NO_DATA:
        "Hozircha bu ma'lumot menda yo'q. Savolingiz jamoamiz uchun saqlandi.",
      GUARDRAIL:
        'Hozir bu savolga ishonchli javob bera olmayman. Savolingiz jamoamiz uchun saqlandi.',
      BUDGET_EXCEEDED:
        'Hozir suhbatni avtomatik davom ettira olmayman. Xabaringiz jamoamiz uchun saqlandi.',
      LLM_UNAVAILABLE:
        'Kechirasiz, texnik nosozlik sababli hozir javob bera olmayman. Xabaringiz jamoamiz uchun saqlandi.',
      CONNECTOR_UNAVAILABLE:
        "Kechirasiz, hozir dolzarb ma'lumotni tekshira olmayman. Xabaringiz jamoamiz uchun saqlandi.",
      TOOL_LOOP_LIMIT:
        'Tekshiruvni yakunlay olmadim. Xabaringiz jamoamiz uchun saqlandi.',
      LOW_LANG_CONFIDENCE:
        "Kechirasiz, sizni to'g'ri tushunganimga ishonchim komil emas. Xabaringiz jamoamiz uchun saqlandi.",
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
    languageClarification:
      'Илтимос, ўзбек, рус ёки инглиз тилида ёзинг. / Пожалуйста, пишите на узбекском, русском или английском. / Please write in Uzbek, Russian or English.',
    aiDisclosure:
      'Мен автоматлаштирилган сунъий интеллект ёрдамчисиман. Сизга мос вариантни танлаш ва долзарб маълумотни текширишда ёрдам бера оламан; исталган вақтда ходим билан боғланишни сўрашингиз мумкин.',
    handover: {
      CUSTOMER_REQUEST:
        'Албатта. Ходим билан боғланиш ҳақидаги сўровингиз сақланди.',
      COMPLAINT:
        'Ноқулайлик учун узр сўраймиз. Мурожаатингиз жамоамиз учун сақланди.',
      NEGOTIATION:
        'Нарх шартлари ва тўлов масалаларини жамоамиз ҳал қилади. Сўровингиз улар учун сақланди.',
      AUTH_REQUIRED:
        'Хавфсизлик учун шахсий ҳисоб маълумотларини бу ерда муҳокама қила олмайман. Саволингиз жамоамиз учун сақланди.',
      NO_DATA:
        'Ҳозирча бу маълумот менда йўқ. Саволингиз жамоамиз учун сақланди.',
      GUARDRAIL:
        'Ҳозир бу саволга ишончли жавоб бера олмайман. Саволингиз жамоамиз учун сақланди.',
      BUDGET_EXCEEDED:
        'Ҳозир суҳбатни автоматик давом эттира олмайман. Хабарингиз жамоамиз учун сақланди.',
      LLM_UNAVAILABLE:
        'Кечирасиз, техник носозлик сабабли ҳозир жавоб бера олмайман. Хабарингиз жамоамиз учун сақланди.',
      CONNECTOR_UNAVAILABLE:
        'Кечирасиз, ҳозир долзарб маълумотни текшира олмайман. Хабарингиз жамоамиз учун сақланди.',
      TOOL_LOOP_LIMIT:
        'Текширувни якунлай олмадим. Хабарингиз жамоамиз учун сақланди.',
      LOW_LANG_CONFIDENCE:
        'Кечирасиз, сизни тўғри тушунганимга ишончим комил эмас. Хабарингиз жамоамиз учун сақланди.',
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
    languageClarification:
      "Пожалуйста, пишите на узбекском, русском или английском. / Iltimos, o'zbek, rus yoki ingliz tilida yozing. / Please write in Uzbek, Russian or English.",
    aiDisclosure:
      'Я автоматический ИИ-ассистент. Я могу помочь подобрать вариант и проверить актуальную информацию; в любой момент можно попросить связать вас с сотрудником.',
    handover: {
      CUSTOMER_REQUEST: 'Конечно. Ваш запрос на связь с сотрудником сохранён.',
      COMPLAINT:
        'Приносим извинения за неудобства. Ваше обращение сохранено для нашей команды.',
      NEGOTIATION:
        'Условия и оплату обсуждает наша команда. Ваш запрос сохранён для неё.',
      AUTH_REQUIRED:
        'В целях безопасности здесь нельзя обсуждать данные личного кабинета. Ваш вопрос сохранён для нашей команды.',
      NO_DATA:
        'Сейчас у меня нет этой информации. Ваш вопрос сохранён для нашей команды.',
      GUARDRAIL:
        'Сейчас я не могу дать на это надёжный ответ. Ваш вопрос сохранён для нашей команды.',
      BUDGET_EXCEEDED:
        'Сейчас я не могу продолжить диалог автоматически. Ваше сообщение сохранено для нашей команды.',
      LLM_UNAVAILABLE:
        'Извините, сейчас я не могу ответить из-за технической проблемы. Ваше сообщение сохранено для нашей команды.',
      CONNECTOR_UNAVAILABLE:
        'Извините, сейчас я не могу проверить актуальную информацию. Ваше сообщение сохранено для нашей команды.',
      TOOL_LOOP_LIMIT:
        'Не удалось завершить проверку. Ваше сообщение сохранено для нашей команды.',
      LOW_LANG_CONFIDENCE:
        'Извините, возможно, я неправильно вас понял. Ваше сообщение сохранено для нашей команды.',
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
    languageClarification:
      "Please write in Uzbek, Russian or English. / Iltimos, o'zbek, rus yoki ingliz tilida yozing. / Пожалуйста, пишите на узбекском, русском или английском.",
    aiDisclosure:
      "I'm an automated AI assistant. I can help you choose an option and check current information, and you can ask for a team member at any time.",
    handover: {
      CUSTOMER_REQUEST:
        'Of course. Your request to talk to a team member has been recorded.',
      COMPLAINT:
        "We're sorry for the inconvenience. Your message has been recorded for our team.",
      NEGOTIATION:
        'Terms and payment questions are handled by our team. Your request has been recorded for them.',
      AUTH_REQUIRED:
        "For your security, personal account details can't be discussed here. Your question has been recorded for our team.",
      NO_DATA:
        "I don't have that information right now. Your question has been recorded for our team.",
      GUARDRAIL:
        "I can't give a reliable answer to that right now. Your question has been recorded for our team.",
      BUDGET_EXCEEDED:
        "I can't continue this conversation automatically right now. Your message has been recorded for our team.",
      LLM_UNAVAILABLE:
        "Sorry, I can't answer right now because of a technical problem. Your message has been recorded for our team.",
      CONNECTOR_UNAVAILABLE:
        "Sorry, I can't check our current information right now. Your message has been recorded for our team.",
      TOOL_LOOP_LIMIT:
        "I couldn't finish checking that. Your message has been recorded for our team.",
      LOW_LANG_CONFIDENCE:
        "Sorry, I'm not sure I understood you. Your message has been recorded for our team.",
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
