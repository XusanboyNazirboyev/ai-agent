'use client';

import type { ReactNode } from 'react';
import { LOCALES, useI18n, type Locale } from '@/i18n';
import { Select } from './ui/select';

/** Short names for the compact header switcher (owner 2026-11-23). */
const SHORT: Record<Locale, string> = { 'uz-Latn': 'UZ', ru: 'RU', en: 'EN' };

export function LocaleSwitcher(props: { compact?: boolean }): ReactNode {
  const { locale, setLocale, t } = useI18n();
  return (
    <Select
      icon="globe"
      compact={props.compact}
      aria-label={t('locale.label')}
      title={t(`locale.${locale}`)}
      value={locale}
      onChange={(event) => setLocale(event.target.value as Locale)}
    >
      {LOCALES.map((id) => (
        <option key={id} value={id}>
          {props.compact ? SHORT[id] : t(`locale.${id}`)}
        </option>
      ))}
    </Select>
  );
}
