import type { Locale } from '@/i18n';

/**
 * Public privacy policy and data deletion instructions (ADR 035 step 2).
 * Written from what the code stores and sends (see the PR description), not
 * from a template. A DRAFT for legal review: company details, the contact
 * address and retention periods are open questions P4 and P5 and render as
 * visible placeholders until the owner provides them. The ru and uz-Latn
 * texts are not native-reviewed.
 *
 * A paragraph is a string; a bullet list is an array. `{company}`,
 * `{address}`, `{email}`, `{retention}` and `{deletionDays}` are replaced
 * by LEGAL_DETAILS (a placeholder while null).
 */
export interface LegalSection {
  readonly heading: string;
  readonly body: readonly (string | readonly string[])[];
}

export interface LegalDocument {
  readonly title: string;
  readonly intro: readonly string[];
  readonly sections: readonly LegalSection[];
}

export const LEGAL_UPDATED = '2026-11-04';

/** Open questions P4/P5 (ADR 035): null until the owner provides them. */
export const LEGAL_DETAILS: Record<
  'company' | 'address' | 'email' | 'retention' | 'deletionDays',
  string | null
> = {
  company: null,
  address: null,
  email: null,
  retention: null,
  // Owner, 2026-11-04.
  deletionDays: '30',
};

const PRIVACY_EN: LegalDocument = {
  title: 'Privacy policy',
  intro: [
    'tezda is a platform that lets businesses answer their customers in messengers (Telegram, Instagram) with an AI assistant and their own operators. This policy explains what tezda stores and sends when you write to a business that uses it, and when a business uses the tezda web app.',
    'tezda is operated by {company}, {address}.',
  ],
  sections: [
    {
      heading: 'Who decides about your data',
      body: [
        'The business you write to decides why your messages are processed and answers for that (it is the controller). tezda processes the data on its behalf to run the service (processor). Questions about a specific business are best sent to that business; you can also write to {email}.',
      ],
    },
    {
      heading: 'What we store about customers',
      body: [
        [
          'Your messenger account id and the display name the messenger shares with the business.',
          'Your phone number, only if you share it in the conversation.',
          'The messages you send and the replies you receive, with their time and delivery status.',
          'The language and script you write in, so that replies use them.',
          'Requests you make (for example a course or a trip you ask about) and a short summary that the business uses as a lead.',
          'Whether you asked not to receive follow-up messages.',
          'Technical records needed to process each message once (message ids, processing status) and records of what the assistant did, for quality and safety.',
        ],
      ],
    },
    {
      heading: 'What we store about business users',
      body: [
        'Name, e-mail address, role, a hash of the password (never the password itself), login sessions, and a record of important actions (audit log). The web app uses a session cookie for signed-in users only; your language choice is kept in your browser.',
      ],
    },
    {
      heading: 'Why we use the data',
      body: [
        [
          'To deliver messages between you and the business and to let the assistant prepare or send replies.',
          'To hand a conversation over to a person when the assistant should not answer.',
          'To pass a request you make to the business (and, if the business connected one, to its CRM).',
          'To keep the service secure, to measure cost and quality, and to fix errors.',
        ],
        'Prices, dates and availability in replies come from the business’s own systems, not from the AI model.',
      ],
    },
    {
      heading: 'Who receives the data',
      body: [
        [
          'The messenger you use (Telegram or Meta for Instagram), to deliver messages.',
          'The AI model provider the business uses to prepare replies and search its knowledge texts. On this server that is Google (Gemini API). The text of the conversation is sent to it for each reply.',
          'The business’s CRM (for example Bitrix24), only if the business connected one, for requests and leads.',
          'Amazon Web Services, which hosts the servers and the database in the European Union (Frankfurt, Germany).',
        ],
        'We do not sell personal data and do not use it for advertising.',
      ],
    },
    {
      heading: 'Where the data is kept and for how long',
      body: [
        'The data is stored in the database of the tezda server in Frankfurt, Germany. Conversations are kept for {retention}. Backups of the database are kept for 7 days and then deleted.',
      ],
    },
    {
      heading: 'Your choices and rights',
      body: [
        [
          'To stop follow-up messages, send a message such as “stop” in the chat.',
          'To ask what data is stored about you, to correct it or to have it deleted, see the data deletion page or write to {email}.',
        ],
      ],
    },
    {
      heading: 'Security',
      body: [
        'Connections use HTTPS. Messenger and CRM access keys are stored encrypted. Access to the web app needs a login, and every business sees only its own data.',
      ],
    },
    {
      heading: 'Changes and contact',
      body: [
        'We will update this page when the processing changes; the date below shows the last change. Contact: {company}, {address}, {email}.',
      ],
    },
  ],
};

const DELETION_EN: LegalDocument = {
  title: 'Data deletion',
  intro: [
    'You can ask for the data that tezda stores about you to be deleted. This page explains how.',
  ],
  sections: [
    {
      heading: 'How to ask',
      body: [
        'Write to {email} with the subject “Data deletion”. Say which business you wrote to and on which messenger (Telegram or Instagram), and include your messenger username or the phone number you used, so that we can find your conversations. We may ask you to confirm the request from the same messenger account.',
      ],
    },
    {
      heading: 'What is deleted',
      body: [
        [
          'Your contact record (messenger account id, name, phone number).',
          'Your conversations and messages with that business.',
          'Requests and lead records created from those conversations.',
        ],
        'Copies in the database backups disappear when those backups expire (7 days). Data that the business already sent to its own CRM is held by the business; we will tell the business about your request.',
      ],
    },
    {
      heading: 'When',
      body: [
        'We handle a deletion request within {deletionDays} days and confirm it to you by e-mail. Deletion is done by our staff on request; there is no automatic self-service deletion yet.',
      ],
    },
    {
      heading: 'Only stopping messages',
      body: [
        'If you only want no more follow-up messages, send “stop” in the chat; nothing else is needed.',
      ],
    },
  ],
};

const PRIVACY_RU: LegalDocument = {
  title: 'Политика конфиденциальности',
  intro: [
    'tezda — платформа, с помощью которой компании отвечают клиентам в мессенджерах (Telegram, Instagram) с помощью ИИ-ассистента и своих операторов. Эта политика объясняет, что tezda хранит и передаёт, когда вы пишете компании, которая её использует, и когда компания работает в веб-приложении tezda.',
    'Оператор tezda: {company}, {address}.',
  ],
  sections: [
    {
      heading: 'Кто решает о ваших данных',
      body: [
        'Компания, которой вы пишете, определяет, зачем обрабатываются ваши сообщения, и отвечает за это (контролёр). tezda обрабатывает данные по её поручению, чтобы сервис работал (обработчик). Вопросы о конкретной компании лучше задавать ей; также можно написать на {email}.',
      ],
    },
    {
      heading: 'Что мы храним о клиентах',
      body: [
        [
          'Идентификатор вашего аккаунта в мессенджере и отображаемое имя, которое мессенджер передаёт компании.',
          'Ваш номер телефона — только если вы сообщили его в переписке.',
          'Ваши сообщения и полученные ответы, их время и статус доставки.',
          'Язык и алфавит, на которых вы пишете, чтобы отвечать так же.',
          'Ваши запросы (например, интересующий курс или поездка) и краткое описание, которое компания использует как лид.',
          'Отказались ли вы от повторных сообщений.',
          'Технические записи для однократной обработки каждого сообщения (идентификаторы, статус) и записи о действиях ассистента — для качества и безопасности.',
        ],
      ],
    },
    {
      heading: 'Что мы храним о сотрудниках компаний',
      body: [
        'Имя, e-mail, роль, хеш пароля (сам пароль не хранится), сеансы входа и журнал важных действий. Веб-приложение использует cookie сеанса только для вошедших пользователей; выбранный язык хранится в вашем браузере.',
      ],
    },
    {
      heading: 'Зачем мы используем данные',
      body: [
        [
          'Чтобы доставлять сообщения между вами и компанией и чтобы ассистент готовил или отправлял ответы.',
          'Чтобы передать диалог человеку, когда ассистенту не следует отвечать.',
          'Чтобы передать ваш запрос компании (и в её CRM, если компания её подключила).',
          'Чтобы обеспечивать безопасность, учитывать расходы и качество и исправлять ошибки.',
        ],
        'Цены, даты и наличие мест в ответах берутся из систем самой компании, а не из ИИ-модели.',
      ],
    },
    {
      heading: 'Кому передаются данные',
      body: [
        [
          'Мессенджеру, которым вы пользуетесь (Telegram или Meta для Instagram), для доставки сообщений.',
          'Поставщику ИИ-модели, которого использует компания, для подготовки ответов и поиска по её текстам. На этом сервере это Google (Gemini API). Для каждого ответа ему передаётся текст переписки.',
          'В CRM компании (например, Bitrix24) — только если компания её подключила, для запросов и лидов.',
          'Amazon Web Services, где размещены серверы и база данных в Европейском союзе (Франкфурт, Германия).',
        ],
        'Мы не продаём персональные данные и не используем их для рекламы.',
      ],
    },
    {
      heading: 'Где и сколько хранятся данные',
      body: [
        'Данные хранятся в базе данных сервера tezda во Франкфурте (Германия). Переписка хранится {retention}. Резервные копии базы хранятся 7 дней и затем удаляются.',
      ],
    },
    {
      heading: 'Ваш выбор и права',
      body: [
        [
          'Чтобы больше не получать повторные сообщения, напишите в чат, например, «стоп».',
          'Чтобы узнать, какие данные о вас хранятся, исправить или удалить их, откройте страницу удаления данных или напишите на {email}.',
        ],
      ],
    },
    {
      heading: 'Безопасность',
      body: [
        'Соединения защищены HTTPS. Ключи доступа к мессенджерам и CRM хранятся в зашифрованном виде. Вход в веб-приложение требует логина, и каждая компания видит только свои данные.',
      ],
    },
    {
      heading: 'Изменения и контакты',
      body: [
        'При изменении обработки мы обновим эту страницу; дата ниже показывает последнее изменение. Контакты: {company}, {address}, {email}.',
      ],
    },
  ],
};

const DELETION_RU: LegalDocument = {
  title: 'Удаление данных',
  intro: [
    'Вы можете попросить удалить данные, которые tezda хранит о вас. Здесь описано, как это сделать.',
  ],
  sections: [
    {
      heading: 'Как подать запрос',
      body: [
        'Напишите на {email} с темой «Удаление данных». Укажите, какой компании и в каком мессенджере (Telegram или Instagram) вы писали, и добавьте имя пользователя в мессенджере или номер телефона, чтобы мы нашли вашу переписку. Мы можем попросить подтвердить запрос из того же аккаунта мессенджера.',
      ],
    },
    {
      heading: 'Что удаляется',
      body: [
        [
          'Ваша карточка контакта (идентификатор в мессенджере, имя, номер телефона).',
          'Ваши диалоги и сообщения с этой компанией.',
          'Запросы и лиды, созданные из этих диалогов.',
        ],
        'Копии в резервных копиях базы исчезают, когда эти копии удаляются (7 дней). Данные, которые компания уже передала в свою CRM, хранятся у компании; мы сообщим компании о вашем запросе.',
      ],
    },
    {
      heading: 'Сроки',
      body: [
        'Мы обрабатываем запрос на удаление в течение {deletionDays} дней и подтверждаем его по e-mail. Удаление выполняют наши сотрудники по запросу; автоматического удаления самостоятельно пока нет.',
      ],
    },
    {
      heading: 'Если нужно только прекратить сообщения',
      body: [
        'Если вы просто не хотите получать повторные сообщения, напишите в чат «стоп» — больше ничего не нужно.',
      ],
    },
  ],
};

const PRIVACY_UZ: LegalDocument = {
  title: 'Maxfiylik siyosati',
  intro: [
    'tezda — bizneslarga mijozlariga messenjerlarda (Telegram, Instagram) sun’iy intellekt yordamchisi va o‘z operatorlari orqali javob berish imkonini beradigan platforma. Ushbu siyosat siz tezda’dan foydalanadigan biznesga yozganingizda va biznes tezda veb-ilovasida ishlaganida tezda nimani saqlashi va kimga yuborishini tushuntiradi.',
    'tezda operatori: {company}, {address}.',
  ],
  sections: [
    {
      heading: 'Ma’lumotlaringiz haqida kim qaror qiladi',
      body: [
        'Siz yozayotgan biznes xabarlaringiz nima uchun qayta ishlanishini belgilaydi va buning uchun javob beradi (nazoratchi). tezda xizmat ishlashi uchun ma’lumotlarni uning topshirig‘iga ko‘ra qayta ishlaydi (qayta ishlovchi). Muayyan biznes haqidagi savollarni o‘sha biznesga bergan ma’qul; {email} manziliga ham yozishingiz mumkin.',
      ],
    },
    {
      heading: 'Mijozlar haqida nima saqlanadi',
      body: [
        [
          'Messenjerdagi hisobingiz identifikatori va messenjer biznesga beradigan ko‘rinadigan ismingiz.',
          'Telefon raqamingiz — faqat uni yozishmada o‘zingiz bersangiz.',
          'Siz yuborgan xabarlar va olgan javoblaringiz, ularning vaqti va yetkazilish holati.',
          'Javoblar shu tilda bo‘lishi uchun siz yozayotgan til va alifbo.',
          'So‘rovlaringiz (masalan, qiziqqan kurs yoki sayohat) va biznes lid sifatida foydalanadigan qisqa tavsif.',
          'Qayta xabar olishdan voz kechganingiz yoki yo‘qligi.',
          'Har bir xabarni bir marta qayta ishlash uchun texnik yozuvlar (identifikatorlar, holat) hamda sifat va xavfsizlik uchun yordamchi harakatlari yozuvlari.',
        ],
      ],
    },
    {
      heading: 'Biznes xodimlari haqida nima saqlanadi',
      body: [
        'Ism, e-mail, rol, parolning xeshi (parolning o‘zi saqlanmaydi), kirish seanslari va muhim harakatlar jurnali. Veb-ilova faqat tizimga kirgan foydalanuvchilar uchun seans cookie’sidan foydalanadi; tanlangan til brauzeringizda saqlanadi.',
      ],
    },
    {
      heading: 'Ma’lumotlardan nima uchun foydalaniladi',
      body: [
        [
          'Siz bilan biznes o‘rtasida xabarlarni yetkazish va yordamchiga javob tayyorlash yoki yuborish uchun.',
          'Yordamchi javob bermasligi kerak bo‘lganda suhbatni insonga topshirish uchun.',
          'So‘rovingizni biznesga (va agar biznes ulagan bo‘lsa, uning CRM tizimiga) yetkazish uchun.',
          'Xavfsizlikni ta’minlash, xarajat va sifatni o‘lchash hamda xatolarni tuzatish uchun.',
        ],
        'Javoblardagi narxlar, sanalar va bo‘sh joylar sun’iy intellekt modelidan emas, biznesning o‘z tizimlaridan olinadi.',
      ],
    },
    {
      heading: 'Ma’lumotlar kimga uzatiladi',
      body: [
        [
          'Xabarlarni yetkazish uchun siz foydalanadigan messenjerga (Telegram yoki Instagram uchun Meta).',
          'Javob tayyorlash va bilimlar matnlarida qidirish uchun biznes foydalanadigan sun’iy intellekt modeli provayderiga. Ushbu serverda bu Google (Gemini API). Har bir javob uchun unga yozishma matni yuboriladi.',
          'So‘rovlar va lidlar uchun biznesning CRM tizimiga (masalan, Bitrix24) — faqat biznes uni ulagan bo‘lsa.',
          'Serverlar va ma’lumotlar bazasi joylashgan Amazon Web Services’ga, Yevropa Ittifoqida (Frankfurt, Germaniya).',
        ],
        'Biz shaxsiy ma’lumotlarni sotmaymiz va reklama uchun ishlatmaymiz.',
      ],
    },
    {
      heading: 'Ma’lumotlar qayerda va qancha saqlanadi',
      body: [
        'Ma’lumotlar tezda serverining Frankfurtdagi (Germaniya) ma’lumotlar bazasida saqlanadi. Yozishmalar {retention} saqlanadi. Bazaning zaxira nusxalari 7 kun saqlanadi, so‘ng o‘chiriladi.',
      ],
    },
    {
      heading: 'Tanlovingiz va huquqlaringiz',
      body: [
        [
          'Qayta xabarlarni to‘xtatish uchun chatga, masalan, “stop” deb yozing.',
          'Siz haqingizda qanday ma’lumot saqlanishini bilish, uni tuzatish yoki o‘chirish uchun ma’lumotlarni o‘chirish sahifasini oching yoki {email} manziliga yozing.',
        ],
      ],
    },
    {
      heading: 'Xavfsizlik',
      body: [
        'Ulanishlar HTTPS bilan himoyalangan. Messenjer va CRM kirish kalitlari shifrlangan holda saqlanadi. Veb-ilovaga kirish login talab qiladi va har bir biznes faqat o‘z ma’lumotlarini ko‘radi.',
      ],
    },
    {
      heading: 'O‘zgarishlar va aloqa',
      body: [
        'Qayta ishlash o‘zgarganda ushbu sahifani yangilaymiz; quyidagi sana oxirgi o‘zgarishni ko‘rsatadi. Aloqa: {company}, {address}, {email}.',
      ],
    },
  ],
};

const DELETION_UZ: LegalDocument = {
  title: 'Ma’lumotlarni o‘chirish',
  intro: [
    'tezda siz haqingizda saqlayotgan ma’lumotlarni o‘chirishni so‘rashingiz mumkin. Bu sahifa buni qanday qilishni tushuntiradi.',
  ],
  sections: [
    {
      heading: 'Qanday so‘rash mumkin',
      body: [
        '{email} manziliga “Ma’lumotlarni o‘chirish” mavzusi bilan yozing. Qaysi biznesga va qaysi messenjerda (Telegram yoki Instagram) yozganingizni ayting hamda yozishmalaringizni topishimiz uchun messenjerdagi foydalanuvchi nomingiz yoki ishlatgan telefon raqamingizni qo‘shing. So‘rovni o‘sha messenjer hisobidan tasdiqlashingizni so‘rashimiz mumkin.',
      ],
    },
    {
      heading: 'Nima o‘chiriladi',
      body: [
        [
          'Kontakt yozuvingiz (messenjer identifikatori, ism, telefon raqami).',
          'O‘sha biznes bilan suhbatlaringiz va xabarlaringiz.',
          'Shu suhbatlardan yaratilgan so‘rovlar va lidlar.',
        ],
        'Bazaning zaxira nusxalaridagi nusxalar zaxiralar muddati tugaganda (7 kun) yo‘qoladi. Biznes o‘z CRM tizimiga allaqachon yuborgan ma’lumotlar biznesning o‘zida saqlanadi; so‘rovingiz haqida biznesga xabar beramiz.',
      ],
    },
    {
      heading: 'Muddati',
      body: [
        'O‘chirish so‘rovini {deletionDays} kun ichida bajaramiz va buni e-mail orqali tasdiqlaymiz. O‘chirishni so‘rov bo‘yicha xodimlarimiz bajaradi; hozircha avtomatik o‘z-o‘zidan o‘chirish yo‘q.',
      ],
    },
    {
      heading: 'Faqat xabarlarni to‘xtatish',
      body: [
        'Agar faqat qayta xabarlar olishni istamasangiz, chatga “stop” deb yozing — boshqa hech narsa kerak emas.',
      ],
    },
  ],
};

export const PRIVACY: Record<Locale, LegalDocument> = {
  en: PRIVACY_EN,
  ru: PRIVACY_RU,
  'uz-Latn': PRIVACY_UZ,
};

export const DATA_DELETION: Record<Locale, LegalDocument> = {
  en: DELETION_EN,
  ru: DELETION_RU,
  'uz-Latn': DELETION_UZ,
};
