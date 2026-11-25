import { copy, salesPack } from '../sales/sales-pack.js';

export const SERVICES_PACK = salesPack({
  key: 'services',
  pipelineName: copy(
    'Xizmat so‘rovlari',
    'Хизмат сўровлари',
    'Заявки на услуги',
    'Service inquiries',
  ),
  capabilities: copy(
    'Kerakli xizmatni topishga va narx ma’lum bo‘lsa, uni katalogdan tekshirishga yordam beraman.',
    'Керакли хизматни топишга ва нарх маълум бўлса, уни каталогдан текширишга ёрдам бераман.',
    'Помогу найти нужную услугу и уточнить цену, если она есть в каталоге.',
    'I can help find a service and check its price if it is in the catalog.',
  ),
  role: 'Help customers find advertised services. Capture desired location and timing as preferences. Route requests to arrange, change or cancel a service appointment to the team (human_request).',
  limitations:
    'Do not promise a time, service area, result or fixed price without verified data. A preferred time is a request for the team to confirm. Never claim that a service has been booked or paid for.',
  retryHint: copy(
    'Kerakli xizmat nomini yoki qanday yordam kerakligini yozing.',
    'Керакли хизмат номини ёки қандай ёрдам кераклигини ёзинг.',
    'Напишите название услуги или опишите, какая помощь нужна.',
    'Name the service or describe the help you need.',
  ),
  fields: [
    {
      key: 'service',
      description:
        'The requested service name or category. Leave location, timing and other requirements out of the service title search.',
      label: copy('Xizmat', 'Хизмат', 'Услуга', 'Service'),
      question: copy(
        'Qaysi xizmat kerak?',
        'Қайси хизмат керак?',
        'Какая услуга вам нужна?',
        'What service do you need?',
      ),
    },
    {
      key: 'service_area',
      description:
        'The city, district or area where the customer needs the service. Avoid asking for a precise address at this stage.',
      label: copy(
        'Xizmat hududi',
        'Хизмат ҳудуди',
        'Район оказания услуги',
        'Service area',
      ),
      question: copy(
        'Xizmat qaysi hududda kerak?',
        'Хизмат қайси ҳудудда керак?',
        'В каком районе нужна услуга?',
        'Where do you need the service?',
      ),
    },
    {
      key: 'preferred_time',
      description:
        "The customer's preferred day or time as written. It is not a scheduled appointment or verified availability.",
      label: copy(
        'Qulay vaqt',
        'Қулай вақт',
        'Удобное время',
        'Preferred time',
      ),
      question: copy(
        'Sizga qachon qulay?',
        'Сизга қачон қулай?',
        'Когда вам удобно?',
        'What time works for you?',
      ),
    },
  ],
});
