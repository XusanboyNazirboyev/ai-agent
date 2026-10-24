'use client';

import type { ReactNode } from 'react';
import { LOCALES, useI18n, type Locale } from '@/i18n';

export function LocaleSwitcher(): ReactNode {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">{t('locale.label')}</span>
      <select
        aria-label={t('locale.label')}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        {LOCALES.map((id) => (
          <option key={id} value={id}>
            {t(`locale.${id}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
