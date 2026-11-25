import { budget, copy, salesPack } from '../sales/sales-pack.js';

export const AUTO_SALES_PACK = salesPack({
  key: 'auto-sales',
  pipelineName: copy(
    'Avtomobil savdosi',
    'Автомобиль савдоси',
    'Продажи автомобилей',
    'Vehicle sales',
  ),
  capabilities: copy(
    'Katalogdan avtomobil topishga yordam beraman. Test-drayv yoki xarid bo‘yicha jamoaga murojaat qilishingiz mumkin.',
    'Каталогдан автомобиль топишга ёрдам бераман. Тест-драйв ёки харид бўйича жамоага мурожаат қилишингиз мумкин.',
    'Помогу найти автомобиль в каталоге. Тест-драйв или покупку можно обсудить с командой.',
    'I can help find vehicles in the catalog. The team can discuss a test drive or purchase.',
  ),
  role: 'Help customers find listed vehicles. Track make, model and condition as preferences. Route requests to arrange a test drive, reserve a vehicle or buy it to the dealership team (human_request).',
  limitations:
    'Never infer mileage, condition, vehicle history, financing terms or stock. A test drive, reservation, trade-in valuation or purchase needs separate confirmation by the dealership.',
  retryHint: copy(
    'Avtomobil markasi, modeli yoki turini yozing.',
    'Автомобиль маркаси, модели ёки турини ёзинг.',
    'Укажите марку, модель или тип автомобиля.',
    'Enter a make, model or vehicle type.',
  ),
  fields: [
    {
      key: 'vehicle',
      description:
        'The desired vehicle make, model or body type. Keep the title search focused on the stated make/model or category, without budget, mileage or condition.',
      label: copy('Avtomobil', 'Автомобиль', 'Автомобиль', 'Vehicle'),
      question: copy(
        'Qaysi marka yoki modeldagi avtomobilni qidiryapsiz?',
        'Қайси марка ёки моделдаги автомобилни қидиряпсиз?',
        'Автомобиль какой марки или модели вы ищете?',
        'What make or model are you looking for?',
      ),
    },
    {
      key: 'vehicle_condition',
      description:
        'Whether the customer prefers new or used, as stated by the customer.',
      label: copy('Holati', 'Ҳолати', 'Состояние', 'Condition'),
      question: copy(
        'Yangi avtomobil kerakmi yoki yurganini ham ko‘rasizmi?',
        'Янги автомобиль керакми ёки юрганини ҳам кўрасизми?',
        'Нужен новый автомобиль или рассматриваете подержанный?',
        'Are you looking for a new or used vehicle?',
      ),
    },
    budget,
  ],
});
