'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { ChannelLogo } from './ui/channel-logo';
import { Icon, type IconName } from './ui/icons';

export type ChannelsSection =
  'telegram' | 'instagram' | 'facebook' | 'whatsapp' | 'webchat' | 'replies';

/**
 * Owner 2026-11-24: every messenger has its own tab (WhatsApp and web chat
 * show their "soon" card), quick replies the last.
 */
export const CHANNELS_SECTIONS: readonly {
  key: ChannelsSection;
  href: string;
}[] = [
  { key: 'telegram', href: '/channels/telegram' },
  { key: 'instagram', href: '/channels/instagram' },
  { key: 'facebook', href: '/channels/facebook' },
  { key: 'whatsapp', href: '/channels/whatsapp' },
  { key: 'webchat', href: '/channels/webchat' },
  { key: 'replies', href: '/channels/replies' },
];

/** Tabs without a brand logo of their own. */
const TAB_ICONS: Partial<Record<ChannelsSection, IconName>> = {
  whatsapp: 'phone',
  webchat: 'globe',
  replies: 'message',
};

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
                {section.key in TAB_ICONS ? (
                  <Icon
                    name={TAB_ICONS[section.key]!}
                    className="h-4 w-4 shrink-0"
                  />
                ) : (
                  <ChannelLogo channelType={section.key} decorative />
                )}
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
