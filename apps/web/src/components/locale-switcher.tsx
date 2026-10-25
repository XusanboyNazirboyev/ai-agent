'use client';

import type { ReactNode } from 'react';
import { LOCALES, useI18n, type Locale } from '@/i18n';
import { Icon } from './ui/icons';
import { selectClass } from './ui/fields';

export function LocaleSwitcher(): ReactNode {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="relative flex items-center">
      <span className="sr-only">{t('locale.label')}</span>
      <span className="pointer-events-none absolute left-2.5 text-muted">
        <Icon name="globe" />
      </span>
      <select
        aria-label={t('locale.label')}
        className={`${selectClass} min-w-0 pl-8`}
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
