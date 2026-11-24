import en from './en.json';

export type Messages = Record<string, string>;
type Locale = 'uz-Latn' | 'ru' | 'en';

/**
 * Owner 2026-11-24 (slow pages): only English ships in the main bundle, as the
 * fallback for every key; Russian and Uzbek are separate chunks loaded when
 * chosen, so a page no longer downloads and parses all three (~415 KB).
 */
export const CATALOGS: Partial<Record<Locale, Messages>> & { en: Messages } = {
  en,
};

type LazyLocale = 'ru' | 'uz-Latn';

const LOADERS: Record<LazyLocale, () => Promise<Messages>> = {
  ru: () => import('./ru.json').then((m) => m.default as Messages),
  'uz-Latn': () => import('./uz-Latn.json').then((m) => m.default as Messages),
};

/** Loads a locale's messages once; English is always there. */
export async function loadCatalog(locale: Locale): Promise<void> {
  if (CATALOGS[locale]) return;
  CATALOGS[locale] = await LOADERS[locale as LazyLocale]();
}
