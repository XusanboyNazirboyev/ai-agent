'use client';

import IntlMessageFormat from 'intl-messageformat';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import en from './en.json';
import ru from './ru.json';
import uzLatn from './uz-Latn.json';

export const LOCALES = ['uz-Latn', 'ru', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export type Messages = Record<string, string>;

export const CATALOGS: Record<Locale, Messages> = {
  en,
  ru,
  'uz-Latn': uzLatn,
};

const STORAGE_KEY = 'ac_locale';

export function detectLocale(
  stored: string | null | undefined,
  languages: readonly string[],
): Locale {
  if (stored && (LOCALES as readonly string[]).includes(stored))
    return stored as Locale;
  for (const language of languages) {
    const base = language.toLowerCase().split('-')[0];
    if (base === 'uz') return 'uz-Latn';
    if (base === 'ru') return 'ru';
    if (base === 'en') return 'en';
  }
  return 'en';
}

const formatters = new Map<string, IntlMessageFormat>();

/** Formats an ICU message; an unknown key returns the key (never throws). */
export function translate(
  locale: Locale,
  key: string,
  values?: Record<string, string | number>,
): string {
  const message = CATALOGS[locale][key] ?? CATALOGS.en[key];
  if (message === undefined) return key;
  const cacheKey = `${locale}\u0000${key}`;
  let formatter = formatters.get(cacheKey);
  if (!formatter) {
    formatter = new IntlMessageFormat(message, locale);
    formatters.set(cacheKey, formatter);
  }
  try {
    return String(formatter.format(values));
  } catch {
    return key;
  }
}

interface I18n {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, values?: Record<string, string | number>) => string;
  formatDateTime: (value: string | Date, timeZone?: string) => string;
}

const Context = createContext<I18n | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }): ReactNode {
  const [locale, setLocaleState] = useState<Locale>('en');
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage may be blocked; the browser language still works.
    }
    setLocaleState(detectLocale(stored, window.navigator.languages ?? []));
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale === 'uz-Latn' ? 'uz' : locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not persisted; applies to this page view.
    }
  }, []);

  const value = useMemo<I18n>(
    () => ({
      locale,
      setLocale,
      t: (key, values) => translate(locale, key, values),
      formatDateTime: (input, timeZone) => {
        const date = typeof input === 'string' ? new Date(input) : input;
        try {
          return new Intl.DateTimeFormat(
            locale === 'uz-Latn' ? 'uz-Latn' : locale,
            {
              dateStyle: 'short',
              timeStyle: 'short',
              ...(timeZone ? { timeZone } : {}),
            },
          ).format(date);
        } catch {
          return date.toISOString();
        }
      },
    }),
    [locale, setLocale],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(Context);
  if (!value) throw new Error('useI18n needs an I18nProvider');
  return value;
}
