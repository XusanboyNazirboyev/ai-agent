import { DomainPackSchema, type DomainPack } from '@agentcore/shared';

/**
 * General sales and service pack (owner 2026-11-23, ADR 087): any business
 * that no vertical pack fits (a shop, a salon, a service centre). It asks
 * only what every sale needs, what the customer wants and how many, and
 * finds it in the tenant's own catalog by the customer's words. Items,
 * prices and availability always come from the connector.
 */
export const GENERAL_PACK: DomainPack = DomainPackSchema.parse({
  key: 'general',
  version: '1',
  catalogItemType: 'item',
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
      'Men shu biznesning yordamchisiman: mahsulot va xizmatlar, ularning narxi va mavjudligi haqida ma’lumot beraman hamda buyurtma yoki so‘rov qoldirishga yordam beraman.',
    'uz-Cyrl':
      'Мен шу бизнеснинг ёрдамчисиман: маҳсулот ва хизматлар, уларнинг нархи ва мавжудлиги ҳақида маълумот бераман ҳамда буюртма ёки сўров қолдиришга ёрдам бераман.',
    ru: 'Я помощник этого бизнеса: рассказываю о товарах и услугах, их цене и наличии и помогаю оставить заказ или заявку.',
    en: "I'm this business's assistant: I can tell you about its products and services, their prices and availability, and help you place an order or request.",
  },
  prompt: {
    businessRole:
      'You are a sales and customer-service assistant for this business. You help customers find the products or services it offers and understand prices and availability.',
    rules: [
      'Describe only products or services the catalog returned; never assume what the business sells beyond them.',
      'Never promise delivery times, stock or service results that the catalog or knowledge did not confirm.',
    ],
  },
  slots: [
    {
      key: 'need',
      type: 'text',
      description:
        'The product or service the customer wants, in their own words (e.g. "iPhone 15", "teeth whitening", "wedding cake").',
      maxLength: 80,
      requiredFor: ['search'],
      searchFilter: { kind: 'title' },
      questions: {
        'uz-Latn': 'Qaysi mahsulot yoki xizmat sizni qiziqtiradi?',
        'uz-Cyrl': 'Қайси маҳсулот ёки хизмат сизни қизиқтиради?',
        ru: 'Какой товар или услуга вас интересует?',
        en: 'Which product or service are you interested in?',
      },
      retryHint: {
        'uz-Latn': 'Iltimos, kerakli mahsulot yoki xizmat nomini yozing.',
        'uz-Cyrl': 'Илтимос, керакли маҳсулот ёки хизмат номини ёзинг.',
        ru: 'Пожалуйста, напишите название нужного товара или услуги.',
        en: 'Please write the name of the product or service you need.',
      },
    },
    {
      key: 'quantity',
      type: 'integer',
      description: 'How many items or how many people the request is for.',
      min: 1,
      max: 1000,
      questions: {
        'uz-Latn': 'Nechta kerak?',
        'uz-Cyrl': 'Нечта керак?',
        ru: 'Сколько вам нужно?',
        en: 'How many do you need?',
      },
    },
  ],
  crmTemplate: {
    key: 'sales',
    pipelineName: {
      'uz-Latn': 'Sotuvlar',
      'uz-Cyrl': 'Сотувлар',
      ru: 'Продажи',
      en: 'Sales',
    },
    // The agent's staging codes (ADR 058), so it can move leads forward.
    stages: [
      { code: 'NEW', kind: 'OPEN' },
      { code: 'CONTACTED', kind: 'OPEN' },
      { code: 'QUALIFIED', kind: 'OPEN' },
      { code: 'PROPOSAL', kind: 'OPEN' },
      { code: 'NEGOTIATION', kind: 'OPEN' },
      { code: 'WON', kind: 'WON' },
      { code: 'LOST', kind: 'LOST' },
    ],
    leadFields: [
      {
        key: 'need',
        type: 'TEXT',
        label: {
          'uz-Latn': 'Nima kerak',
          'uz-Cyrl': 'Нима керак',
          ru: 'Что нужно',
          en: 'Need',
        },
      },
      {
        key: 'quantity',
        type: 'NUMBER',
        label: {
          'uz-Latn': 'Soni',
          'uz-Cyrl': 'Сони',
          ru: 'Количество',
          en: 'Quantity',
        },
      },
    ],
  },
  actions: [
    {
      key: 'order_request',
      operation: 'createLead',
      triggerIntents: ['booking_interest'],
      confirmation: 'explicit',
      expiresAfterMinutes: 60,
      crmSummary: 'Order or service request confirmed by the customer in chat',
      showExternalReference: true,
      title: {
        'uz-Latn': 'buyurtma so‘rovi',
        'uz-Cyrl': 'буюртма сўрови',
        ru: 'заявка',
        en: 'order request',
      },
      fields: [
        {
          name: 'slots.need',
          from: { kind: 'slot', slot: 'need' },
          required: true,
          label: {
            'uz-Latn': 'Nima kerak',
            'uz-Cyrl': 'Нима керак',
            ru: 'Что нужно',
            en: 'Need',
          },
        },
        {
          name: 'slots.quantity',
          from: { kind: 'slot', slot: 'quantity' },
          required: false,
          label: {
            'uz-Latn': 'Soni',
            'uz-Cyrl': 'Сони',
            ru: 'Количество',
            en: 'Quantity',
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
