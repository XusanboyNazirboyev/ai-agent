import { budget, copy, salesPack } from '../sales/sales-pack.js';

export const FURNITURE_PACK = salesPack({
  key: 'furniture',
  pipelineName: copy(
    'Mebel savdosi',
    'Мебель савдоси',
    'Продажи мебели',
    'Furniture sales',
  ),
  capabilities: copy(
    'Katalogdan tayyor mebel topishga yordam beraman. O‘lcham bo‘yicha mebel kerak bo‘lsa, so‘rovingizni jamoa ko‘rib chiqadi.',
    'Каталогдан тайёр мебель топишга ёрдам бераман. Ўлчам бўйича мебель керак бўлса, сўровингизни жамоа кўриб чиқади.',
    'Помогу найти готовую мебель в каталоге. Заявку на мебель по размерам рассмотрит команда.',
    'I can help find ready-made furniture in the catalog. The team reviews requests for custom furniture.',
  ),
  role: 'Help customers choose listed furniture. Extract any given dimensions, material, finish, quantity, location and budget as buyer preferences. Route requests for custom fabrication, site measurement, or a tailored estimate to the team (human_request).',
  limitations:
    'Confirm price and stock with tools. If variants differ, ask which one. Never quote a ready-made price for custom work. Do not infer size, material, fees or lead time. Do not confirm orders, reservations, delivery or installation.',
  retryHint: copy(
    'Mebel turini yoki katalogdagi model nomini yozing.',
    'Мебель турини ёки каталогдаги модель номини ёзинг.',
    'Укажите вид мебели или название модели из каталога.',
    'Enter a type of furniture or a model name from the catalog.',
  ),
  fields: [
    {
      key: 'furniture',
      description:
        'The requested furniture type, model name or SKU. Use the stated catalog identifier or item type for title search. Do not append dimensions, material, colour or budget unless they are part of an exact model name.',
      label: copy(
        'Mebel turi yoki modeli',
        'Мебель тури ёки модели',
        'Вид или модель мебели',
        'Furniture type or model',
      ),
      question: copy(
        'Qanday mebel qidiryapsiz?',
        'Қандай мебель қидиряпсиз?',
        'Какую мебель вы ищете?',
        'What kind of furniture are you looking for?',
      ),
    },
    {
      key: 'dimensions',
      description:
        "The buyer's requested dimensions, with the axes and units exactly as supplied (for example width 180 cm and depth 60 cm). Never assume units or use them as catalog dimensions.",
      label: copy(
        'Kerakli o‘lcham',
        'Керакли ўлчам',
        'Желаемые размеры',
        'Requested dimensions',
      ),
      question: copy(
        'Qanday o‘lcham kerak?',
        'Қандай ўлчам керак?',
        'Какие размеры нужны?',
        'What dimensions do you need?',
      ),
    },
    {
      key: 'material',
      description:
        'The desired material, if stated. It does not assert which material the catalog item uses.',
      label: copy('Material', 'Материал', 'Материал', 'Material'),
      question: copy(
        'Qaysi materialni xohlaysiz?',
        'Қайси материални хоҳлайсиз?',
        'Какой материал вам нужен?',
        'What material do you prefer?',
      ),
    },
    {
      key: 'finish',
      description:
        'The colour or surface finish the buyer wants, without assuming the seller can provide it.',
      label: copy(
        'Rang yoki qoplama',
        'Ранг ёки қоплама',
        'Цвет или отделка',
        'Colour or finish',
      ),
      question: copy(
        'Qaysi rang yoki qoplama yoqadi?',
        'Қайси ранг ёки қоплама ёқади?',
        'Какой цвет или отделка вам подходят?',
        'Which colour or finish works for you?',
      ),
    },
    {
      key: 'quantity',
      description: 'The number of furniture units the buyer requests.',
      integerMax: 1000,
      label: copy('Soni', 'Сони', 'Количество', 'Quantity'),
      question: copy(
        'Nechta kerak?',
        'Нечта керак?',
        'Сколько единиц нужно?',
        'How many units do you need?',
      ),
    },
    {
      key: 'delivery_area',
      description:
        'The city or district for delivery or installation, if stated. Do not collect a precise address in order to quote the catalog item.',
      label: copy(
        'Yetkazish hududi',
        'Етказиш ҳудуди',
        'Район доставки',
        'Delivery area',
      ),
      question: copy(
        'Qaysi shahar yoki tumanga yetkazish kerak?',
        'Қайси шаҳар ёки туманга етказиш керак?',
        'В какой город или район нужна доставка?',
        'Which city or district needs delivery?',
      ),
    },
    budget,
  ],
});
