'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { useShell } from './app-shell';
import { Icon, type IconName } from './ui/icons';

const ITEMS: {
  key: 'analytics' | 'bot' | 'knowledge' | 'channels' | 'settings';
  icon: IconName;
}[] = [
  { key: 'analytics', icon: 'chart' },
  { key: 'bot', icon: 'bot' },
  { key: 'knowledge', icon: 'book' },
  { key: 'channels', icon: 'link' },
  { key: 'settings', icon: 'sliders' },
];

/** The tab bar's overflow: the sections that do not fit on a phone. */
export function MorePage(): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const items = ITEMS.filter(
    (item) =>
      item.key !== 'analytics' ||
      operator.role === 'OWNER' ||
      operator.role === 'ADMIN',
  );
  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('nav.more')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-xl flex-col gap-3 p-3 sm:p-6">
        <p className="text-sm text-muted">{t('more.intro')}</p>
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.key}>
              <Link
                href={`/${item.key}`}
                className="flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card transition-colors hover:border-primary"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-fg">
                  <Icon name={item.icon} className="h-5 w-5" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{t(`nav.${item.key}`)}</span>
                  <span className="text-sm text-muted">
                    {t(`more.desc.${item.key}`)}
                  </span>
                </span>
                <Icon
                  name="chevronRight"
                  className="h-4 w-4 shrink-0 text-muted"
                />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
