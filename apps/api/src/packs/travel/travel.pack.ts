import { DomainPackSchema, type DomainPack } from '@agentcore/shared';

/**
 * Travel Domain Pack — second domain, onboarded as pure configuration (Phase
 * 7.1): its own slots, questions, prompt rules and business action. It is a
 * conformance example for universality, validated against the fictional mock
 * tourism catalog; tours, prices and dates always come from the connector.
 */
export const TRAVEL_PACK: DomainPack = DomainPackSchema.parse({
  key: 'travel',
  version: '1',
  catalogItemType: 'tour',
  locales: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
  maxOptionsShown: 3,
  tools: [
    'search_catalog',
    'get_item_details',
    'list_offers',
    'check_availability',
    'get_quote',
    'knowledge_search',
  ],
  capabilities: {
    'uz-Latn':
      "Men sayohat agentligining yordamchisiman: turlar, ularning narxi, sanalari va bo'sh joylar haqida ma'lumot beraman hamda bron qilishga yordam beraman.",
    'uz-Cyrl':
      'Мен саёҳат агентлигининг ёрдамчисиман: турлар, уларнинг нархи, саналари ва бўш жойлар ҳақида маълумот бераман ҳамда брон қилишга ёрдам бераман.',
    ru: 'Я помощник турагентства: рассказываю о турах, их стоимости, датах и свободных местах и помогаю забронировать.',
    en: "I'm the travel agency's assistant: I can tell you about tours, their prices, dates and free places, and help you book.",
  },
  prompt: {
    businessRole:
      'You are a travel consultant for a tour operator. You help travellers find a suitable tour and understand departures, availability and prices.',
    rules: [
      'Never state visa, entry or health requirements from memory; only from verified, recent knowledge, otherwise a colleague answers.',
      'Never promise a hotel, flight or seat that the catalog did not confirm.',
    ],
  },
  slots: [
    {
      key: 'destination',
      type: 'text',
      description:
        'Where the traveller wants to go: city or country name in English (e.g. "Antalya", "Dubai").',
      maxLength: 60,
      requiredFor: ['search', 'quote'],
      searchFilter: { kind: 'title' },
      questions: {
        'uz-Latn': 'Qayerga sayohat qilmoqchisiz?',
        'uz-Cyrl': 'Қаерга саёҳат қилмоқчисиз?',
        ru: 'Куда вы хотите поехать?',
        en: 'Where would you like to travel?',
      },
    },
    {
      key: 'travelMonth',
      type: 'enum',
      description: 'Month the trip should start.',
      options: [
        {
          value: 'january',
          synonyms: ['yanvar', 'январь', 'январе', 'january'],
        },
        {
          value: 'february',
          synonyms: ['fevral', 'февраль', 'феврале', 'february'],
        },
        { value: 'march', synonyms: ['mart', 'март', 'марте', 'march'] },
        { value: 'april', synonyms: ['aprel', 'апрель', 'апреле', 'april'] },
        { value: 'may', synonyms: ['may', 'май', 'мае'] },
        { value: 'june', synonyms: ['iyun', 'июнь', 'июне', 'june'] },
        { value: 'july', synonyms: ['iyul', 'июль', 'июле', 'july'] },
        {
          value: 'august',
          synonyms: ['avgust', 'август', 'августе', 'august'],
        },
        {
          value: 'september',
          synonyms: ['sentabr', 'сентябрь', 'сентябре', 'september'],
        },
        {
          value: 'october',
          synonyms: ['oktabr', 'октябрь', 'октябре', 'october'],
        },
        {
          value: 'november',
          synonyms: ['noyabr', 'ноябрь', 'ноябре', 'november'],
        },
        {
          value: 'december',
          synonyms: ['dekabr', 'декабрь', 'декабре', 'december'],
        },
      ],
      requiredFor: ['quote'],
      questions: {
        'uz-Latn': 'Qaysi oyda sayohat qilmoqchisiz?',
        'uz-Cyrl': 'Қайси ойда саёҳат қилмоқчисиз?',
        ru: 'В каком месяце вы хотите поехать?',
        en: 'Which month would you like to travel?',
      },
    },
    {
      key: 'partySize',
      type: 'integer',
      description: 'Number of travellers, adults and children together.',
      min: 1,
      max: 20,
      questions: {
        'uz-Latn': 'Necha kishi sayohat qiladi?',
        'uz-Cyrl': 'Неча киши саёҳат қилади?',
        ru: 'Сколько человек поедет?',
        en: 'How many people are travelling?',
      },
    },
    {
      key: 'budget',
      type: 'integer',
      description:
        'Budget per person in US dollars, if the traveller states one.',
      min: 1,
      max: 100000,
      questions: {
        'uz-Latn': 'Bir kishi uchun taxminiy byudjetingiz qancha?',
        'uz-Cyrl': 'Бир киши учун тахминий бюджетингиз қанча?',
        ru: 'Какой примерно бюджет на человека?',
        en: 'What is your approximate budget per person?',
      },
    },
  ],
  crmTemplate: {
    key: 'tourism',
    pipelineName: {
      'uz-Latn': 'Turlar',
      'uz-Cyrl': 'Турлар',
      ru: 'Туры',
      en: 'Tours',
    },
    stages: [
      { code: 'INQUIRY', kind: 'OPEN' },
      { code: 'OFFER_SENT', kind: 'OPEN' },
      { code: 'PREPAYMENT', kind: 'OPEN' },
      { code: 'DOCUMENTS', kind: 'OPEN' },
      { code: 'PAID', kind: 'WON' },
      { code: 'TRAVELLED', kind: 'WON' },
      { code: 'LOST', kind: 'LOST' },
    ],
    leadFields: [
      {
        key: 'destination',
        type: 'TEXT',
        label: {
          'uz-Latn': 'Yo‘nalish',
          'uz-Cyrl': 'Йўналиш',
          ru: 'Направление',
          en: 'Destination',
        },
      },
      {
        key: 'departure_date',
        type: 'DATE',
        label: {
          'uz-Latn': 'Jo‘nash sanasi',
          'uz-Cyrl': 'Жўнаш санаси',
          ru: 'Дата вылета',
          en: 'Departure date',
        },
      },
      {
        key: 'travellers',
        type: 'NUMBER',
        label: {
          'uz-Latn': 'Sayohatchilar soni',
          'uz-Cyrl': 'Саёҳатчилар сони',
          ru: 'Число путешественников',
          en: 'Travellers',
        },
      },
      {
        key: 'budget',
        type: 'NUMBER',
        label: {
          'uz-Latn': 'Byudjet (1 kishi)',
          'uz-Cyrl': 'Бюджет (1 киши)',
          ru: 'Бюджет на человека',
          en: 'Budget per person',
        },
      },
      {
        key: 'needs_visa',
        type: 'BOOLEAN',
        label: {
          'uz-Latn': 'Viza yoki pasport kerak',
          'uz-Cyrl': 'Виза ёки паспорт керак',
          ru: 'Нужна виза или паспорт',
          en: 'Needs a visa or passport',
        },
      },
    ],
    tags: [
      {
        name: {
          'uz-Latn': 'Oilaviy',
          'uz-Cyrl': 'Оилавий',
          ru: 'Семья',
          en: 'Family',
        },
        color: 'green',
      },
      {
        name: {
          'uz-Latn': 'Asal oyi',
          'uz-Cyrl': 'Асал ойи',
          ru: 'Медовый месяц',
          en: 'Honeymoon',
        },
        color: 'purple',
      },
      {
        name: {
          'uz-Latn': 'Qaynoq tur',
          'uz-Cyrl': 'Қайноқ тур',
          ru: 'Горящий тур',
          en: 'Hot tour',
        },
        color: 'red',
      },
    ],
  },
  actions: [
    {
      key: 'trip_request',
      operation: 'createLead',
      triggerIntents: ['booking_interest'],
      confirmation: 'explicit',
      expiresAfterMinutes: 60,
      crmSummary: 'Trip request confirmed by the traveller in chat',
      showExternalReference: true,
      title: {
        'uz-Latn': 'sayohat so‘rovi',
        'uz-Cyrl': 'саёҳат сўрови',
        ru: 'заявка на поездку',
        en: 'trip request',
      },
      fields: [
        {
          name: 'slots.destination',
          from: { kind: 'slot', slot: 'destination' },
          required: true,
          label: {
            'uz-Latn': 'Yo‘nalish',
            'uz-Cyrl': 'Йўналиш',
            ru: 'Направление',
            en: 'Destination',
          },
        },
        {
          name: 'slots.travelMonth',
          from: { kind: 'slot', slot: 'travelMonth' },
          required: true,
          label: { 'uz-Latn': 'Oy', 'uz-Cyrl': 'Ой', ru: 'Месяц', en: 'Month' },
        },
        {
          name: 'slots.partySize',
          from: { kind: 'slot', slot: 'partySize' },
          required: true,
          label: {
            'uz-Latn': 'Kishilar soni',
            'uz-Cyrl': 'Кишилар сони',
            ru: 'Число путешественников',
            en: 'Travellers',
          },
        },
        {
          name: 'slots.budget',
          from: { kind: 'slot', slot: 'budget' },
          required: false,
          label: {
            'uz-Latn': 'Byudjet (1 kishi)',
            'uz-Cyrl': 'Бюджет (1 киши)',
            ru: 'Бюджет на человека',
            en: 'Budget per person',
          },
        },
        {
          name: 'contact.name',
          from: { kind: 'contact', field: 'name' },
          required: true,
          label: { 'uz-Latn': 'Ism', 'uz-Cyrl': 'Исм', ru: 'Имя', en: 'Name' },
        },
        {
          name: 'contact.phone',
          from: { kind: 'contact', field: 'phone' },
          required: true,
          label: {
            'uz-Latn': 'Telefon',
            'uz-Cyrl': 'Телефон',
            ru: 'Телефон',
            en: 'Phone',
          },
        },
      ],
    },
  ],
});
