import type { DomainPack } from '@agentcore/shared';
import { AUTO_SALES_PACK } from './auto-sales/auto-sales.pack.js';
import { EDUCATION_PACK } from './education/education.pack.js';
import { FURNITURE_PACK } from './furniture/furniture.pack.js';
import { GENERAL_PACK } from './general/general.pack.js';
import { HOME_APPLIANCES_PACK } from './home-appliances/home-appliances.pack.js';
import { REAL_ESTATE_PACK } from './real-estate/real-estate.pack.js';
import { copy } from './sales/sales-pack.js';
import { SERVICES_PACK } from './services/services.pack.js';
import { TRAVEL_PACK } from './travel/travel.pack.js';

/** Registration is shared by pack resolution and the public signup picker. */
const PACKS = [
  [
    EDUCATION_PACK,
    copy('O‘quv markazi', 'Ўқув маркази', 'Учебный центр', 'Training centre'),
  ],
  [
    TRAVEL_PACK,
    copy(
      'Turizm agentligi',
      'Туризм агентлиги',
      'Туристическое агентство',
      'Travel agency',
    ),
  ],
  [
    HOME_APPLIANCES_PACK,
    copy(
      'Maishiy texnika savdosi',
      'Маиший техника савдоси',
      'Магазин бытовой техники',
      'Home appliance shop',
    ),
  ],
  [
    AUTO_SALES_PACK,
    copy(
      'Avtosalon yoki avtomobil savdosi',
      'Автосалон ёки автомобиль савдоси',
      'Автосалон или продажа автомобилей',
      'Car dealership or vehicle seller',
    ),
  ],
  [
    REAL_ESTATE_PACK,
    copy(
      'Uy-joy savdosi',
      'Уй-жой савдоси',
      'Продажа недвижимости',
      'Real estate sales',
    ),
  ],
  [
    SERVICES_PACK,
    copy(
      'Xizmat ko‘rsatish',
      'Хизмат кўрсатиш',
      'Продажа услуг',
      'Service business',
    ),
  ],
  [
    FURNITURE_PACK,
    copy(
      'Mebel va buyurtma asosida ishlab chiqarish',
      'Мебель ва буюртма асосида ишлаб чиқариш',
      'Мебель и изготовление на заказ',
      'Furniture and custom manufacturing',
    ),
  ],
  [
    GENERAL_PACK,
    copy('Boshqa biznes', 'Бошқа бизнес', 'Другой бизнес', 'Other business'),
  ],
] as const;

/**
 * Registered Domain Packs by `key@version` (tenants select one). Onboarding a
 * new domain adds its pack here and under `src/packs/<domain>/`; nothing in
 * `src/core/**` changes (Phase 7 universality criterion).
 */
export const DOMAIN_PACKS: ReadonlyMap<string, DomainPack> = new Map(
  PACKS.map(([pack]) => [`${pack.key}@${pack.version}`, pack]),
);

/**
 * Business types a self-serve signup may pick (owner 2026-11-23): one per
 * registered pack key. Anything else is not offered until a pack fits it.
 */
export const SIGNUP_PACK_OPTIONS = [
  ...new Map(
    PACKS.map(([pack, label]) => [pack.key, { key: pack.key, label }]),
  ).values(),
];

export const SIGNUP_PACK_KEYS: readonly string[] = SIGNUP_PACK_OPTIONS.map(
  ({ key }) => key,
);

/** The newest registered pack with this key (versions sort as strings). */
export function packByKey(key: string): DomainPack | undefined {
  return [...DOMAIN_PACKS.values()]
    .filter((pack) => pack.key === key)
    .sort((a, b) => b.version.localeCompare(a.version))[0];
}
