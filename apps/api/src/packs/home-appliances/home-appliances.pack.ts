import { budget, copy, salesPack } from '../sales/sales-pack.js';

export const HOME_APPLIANCES_PACK = salesPack({
  key: 'home-appliances',
  pipelineName: copy(
    'Texnika savdosi',
    'Техника савдоси',
    'Продажи техники',
    'Appliance sales',
  ),
  capabilities: copy(
    'Maishiy texnika topishga va katalogdagi narx hamda mavjudlikni tekshirishga yordam beraman.',
    'Маиший техника топишга ва каталогдаги нарх ҳамда мавжудликни текширишга ёрдам бераман.',
    'Помогу подобрать бытовую технику и уточнить цену и наличие по каталогу.',
    'I can help find appliances and check catalog prices and stock.',
  ),
  role: 'Help customers find home appliances in the tenant catalog. Distinguish a product category from a particular brand or model.',
  limitations:
    'Do not infer specifications, energy ratings, warranties, delivery terms or installment terms. Send delivery, installation, returns and financing questions to the team when the information is not verified.',
  retryHint: copy(
    'Texnika turini yoki modelini yozing.',
    'Техника турини ёки моделини ёзинг.',
    'Укажите вид техники или модель.',
    'Enter an appliance type or model.',
  ),
  fields: [
    {
      key: 'appliance',
      description:
        'The appliance category, brand or model the customer requests. Use the most specific stated product name. Do not add capacity, budget, shipping details or a guessed model to the title search.',
      label: copy('Texnika', 'Техника', 'Техника', 'Appliance'),
      question: copy(
        'Qaysi maishiy texnika yoki model kerak?',
        'Қайси маиший техника ёки модель керак?',
        'Какой вид техники или модель вам нужны?',
        'What type of appliance or model do you need?',
      ),
    },
    {
      key: 'quantity',
      description:
        'The requested number of appliances. Record only if the customer states it.',
      integerMax: 1000,
      label: copy('Soni', 'Сони', 'Количество', 'Quantity'),
      question: copy(
        'Nechta kerak?',
        'Нечта керак?',
        'Сколько единиц вам нужно?',
        'How many do you need?',
      ),
    },
    budget,
  ],
});
