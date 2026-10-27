'use client';

import type { ReactNode } from 'react';
import { LOCALES, useI18n, type Locale } from '@/i18n';
import { Select } from './ui/select';

export function LocaleSwitcher(): ReactNode {
  const { locale, setLocale, t } = useI18n();
  return (
    <Select
      icon="globe"
      aria-label={t('locale.label')}
      value={locale}
      onChange={(event) => setLocale(event.target.value as Locale)}
    >
      {LOCALES.map((id) => (
        <option key={id} value={id}>
          {t(`locale.${id}`)}
        </option>
      ))}
    </Select>
  );
}
