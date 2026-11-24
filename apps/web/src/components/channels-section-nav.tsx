'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { ChannelLogo } from './ui/channel-logo';

export type ChannelsSection = 'telegram' | 'instagram';

/** Owner 2026-11-24: Telegram and Instagram each have their own tab. */
export const CHANNELS_SECTIONS: readonly {
  key: ChannelsSection;
  href: string;
}[] = [
  { key: 'telegram', href: '/channels/telegram' },
  { key: 'instagram', href: '/channels/instagram' },
];

export function ChannelsSubPage(props: {
  active: ChannelsSection;
  children: ReactNode;
}): ReactNode {
  const { t } = useI18n();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav
        aria-label={t('nav.channels')}
        data-testid="channels-tabs"
        className="shrink-0 overflow-x-auto border-b border-line bg-surface px-2 py-1.5 sm:px-4"
      >
        <ul className="flex w-max min-w-full gap-1">
          {CHANNELS_SECTIONS.map((section) => (
            <li key={section.key}>
              <Link
                href={section.href}
                data-testid={`channels-tab-${section.key}`}
                aria-current={props.active === section.key ? 'page' : undefined}
                className={`flex min-h-9 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors ${
                  props.active === section.key
                    ? 'bg-surface-2 text-fg underline decoration-primary decoration-2 underline-offset-8'
                    : 'text-muted hover:bg-surface-2 hover:text-fg'
                }`}
              >
                <ChannelLogo channelType={section.key} decorative />
                {t(`channels.tab.${section.key}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {props.children}
    </div>
  );
}
