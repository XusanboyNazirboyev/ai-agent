'use client';

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { ChannelAccount } from '@/lib/types';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { Icon, type IconName } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';

/** Product names are not translated. */
const CHANNELS: {
  key: 'telegram' | 'instagram' | 'whatsapp' | 'webchat';
  name: string;
  icon: IconName;
  available: boolean;
}[] = [
  { key: 'telegram', name: 'Telegram', icon: 'send', available: true },
  { key: 'instagram', name: 'Instagram', icon: 'message', available: false },
  { key: 'whatsapp', name: 'WhatsApp', icon: 'phone', available: false },
  { key: 'webchat', name: 'Web chat', icon: 'globe', available: false },
];

const MODE_TONE: Record<ChannelAccount['agentMode'], Tone> = {
  OFF: 'neutral',
  SHADOW: 'warning',
  LIVE: 'success',
};

function displayName(type: string): string {
  return (
    CHANNELS.find((channel) => channel.key === type)?.name ??
    type.charAt(0).toUpperCase() + type.slice(1)
  );
}

function Check(props: { on: boolean; children: ReactNode }): ReactNode {
  return (
    <span
      className={`flex items-center gap-1.5 text-sm ${props.on ? '' : 'text-muted'}`}
    >
      <Icon
        name={props.on ? 'check' : 'x'}
        className={`h-4 w-4 shrink-0 ${props.on ? 'text-success-fg' : ''}`}
      />
      {props.children}
    </span>
  );
}

/** Read-only overview of messenger accounts (setup is by the administrator). */
export function ChannelsPage(): ReactNode {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['channels'],
    queryFn: () => api<{ items: ChannelAccount[] }>('/api/v1/channels'),
  });
  const items = query.data?.items ?? [];

  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('nav.channels')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-3 sm:p-6">
        <p className="text-sm text-muted">{t('channels.intro')}</p>

        <section
          aria-labelledby="channels-connected"
          className="flex flex-col gap-3"
        >
          <h2 id="channels-connected" className="font-semibold">
            {t('channels.connected')}
          </h2>
          {query.isPending ? (
            <div
              role="status"
              className="overflow-hidden rounded-2xl border border-line bg-surface"
            >
              <span className="sr-only">{t('app.loading')}</span>
              <SkeletonRows rows={2} />
            </div>
          ) : null}
          {query.isError ? (
            <div className="flex flex-col items-start gap-3">
              <p
                role="alert"
                className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
              >
                <Icon name="alert" />
                {t(errorKey(query.error))}
              </p>
              <Button size="sm" onClick={() => void query.refetch()}>
                {t('app.retry')}
              </Button>
            </div>
          ) : null}
          {query.isSuccess && items.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line bg-surface p-6 text-center text-sm text-muted">
              {t('channels.empty')}
            </p>
          ) : null}
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {items.map((account, index) => (
              <li
                key={account.id}
                data-testid="channel-account"
                className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card"
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-fg">
                      <Icon name="send" className="h-5 w-5" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">
                        {displayName(account.channelType)}
                      </span>
                      <span className="text-xs text-muted">
                        {t('channels.account', { number: index + 1 })}
                      </span>
                    </span>
                  </span>
                  <Badge
                    tone={account.status === 'ACTIVE' ? 'success' : 'neutral'}
                    dot
                  >
                    {t(`channelStatus.${account.status}`)}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={MODE_TONE[account.agentMode]}>
                    {t(`agentMode.${account.agentMode}`)}
                  </Badge>
                  {account.isTestAccount ? (
                    <Badge tone="accent">{t('channels.test')}</Badge>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1.5 border-t border-line pt-3">
                  <Check on={account.credentialsConfigured}>
                    {account.credentialsConfigured
                      ? t('channels.credentialsOn')
                      : t('channels.credentialsOff')}
                  </Check>
                  <Check on={account.operatorGroupConfigured}>
                    {account.operatorGroupConfigured
                      ? t('channels.groupOn')
                      : t('channels.groupOff')}
                  </Check>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section
          aria-labelledby="channels-available"
          className="flex flex-col gap-3"
        >
          <h2 id="channels-available" className="font-semibold">
            {t('channels.available')}
          </h2>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {CHANNELS.map((channel) => {
              const connected =
                channel.available &&
                items.some((account) => account.channelType === channel.key);
              return (
                <li
                  key={channel.key}
                  className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
                        channel.available
                          ? 'bg-primary-soft text-primary-fg'
                          : 'bg-surface-2 text-muted'
                      }`}
                    >
                      <Icon name={channel.icon} className="h-5 w-5" />
                    </span>
                    <Badge
                      tone={
                        connected
                          ? 'success'
                          : channel.available
                            ? 'neutral'
                            : 'accent'
                      }
                    >
                      {channel.available
                        ? connected
                          ? t('channels.live')
                          : t('channels.notConnected')
                        : t('channels.planned')}
                    </Badge>
                  </div>
                  <h3 className="font-medium">{channel.name}</h3>
                  <p className="text-sm text-muted">
                    {t(`channels.desc.${channel.key}`)}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>

        <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-sm text-muted">
          <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
          {t('channels.adminNote')}
        </p>
      </div>
    </div>
  );
}
