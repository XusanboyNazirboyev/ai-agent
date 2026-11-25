import { budget, copy, salesPack } from '../sales/sales-pack.js';

export const REAL_ESTATE_PACK = salesPack({
  key: 'real-estate',
  pipelineName: copy(
    'Uy-joy savdosi',
    'Уй-жой савдоси',
    'Продажи недвижимости',
    'Property sales',
  ),
  capabilities: copy(
    'Katalogdan uy-joy topishga yordam beraman. Uyni ko‘rish vaqtini jamoa bilan kelishishingiz mumkin.',
    'Каталогдан уй-жой топишга ёрдам бераман. Уйни кўриш вақтини жамоа билан келишишингиз мумкин.',
    'Помогу найти жильё в каталоге. Время просмотра можно согласовать с командой.',
    'I can help find homes in the catalog. The team can arrange a viewing.',
  ),
  role: 'Help home buyers find listings. Keep property type, location, room count and budget distinct. Route requests to arrange a viewing, reserve a property or buy it to the team (human_request).',
  limitations:
    'Never infer listing status, price, address, area, ownership or financing. Send requests about contracts, title, mortgages and viewings to the team. Never claim a viewing or sale is confirmed.',
  retryHint: copy(
    'Uy-joy turini yoki e’lon nomini yozing.',
    'Уй-жой турини ёки эълон номини ёзинг.',
    'Укажите тип жилья или название объявления.',
    'Enter the type of home or the listing name.',
  ),
  fields: [
    {
      key: 'property',
      description:
        'The property type or listing name the buyer asks for. Use it for the catalog title search. Keep location, room count and budget in their own slots.',
      label: copy('Uy-joy turi', 'Уй-жой тури', 'Тип жилья', 'Property type'),
      question: copy(
        'Qanday uy-joy qidiryapsiz: kvartirami yoki hovli uy?',
        'Қандай уй-жой қидиряпсиз: квартирами ёки ҳовли уй?',
        'Какое жильё вы ищете: квартиру или частный дом?',
        'What kind of property are you looking for, an apartment or a house?',
      ),
    },
    {
      key: 'location',
      description:
        "The buyer's preferred city, neighborhood or district. This is a preference, not a verified listing address.",
      label: copy('Hudud', 'Ҳудуд', 'Район', 'Area'),
      question: copy(
        'Qaysi shahar yoki tuman sizga mos?',
        'Қайси шаҳар ёки туман сизга мос?',
        'Какой город или район вам подходит?',
        'Which city or district works for you?',
      ),
    },
    {
      key: 'rooms',
      description:
        'The number of rooms requested by the buyer, not a catalog fact.',
      integerMax: 80,
      label: copy(
        'Xonalar soni',
        'Хоналар сони',
        'Количество комнат',
        'Room count',
      ),
      question: copy(
        'Nechta xona kerak?',
        'Нечта хона керак?',
        'Сколько нужно комнат?',
        'How many rooms do you need?',
      ),
    },
    budget,
  ],
});
