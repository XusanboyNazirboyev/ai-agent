'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useI18n } from '@/i18n';
import { api, ApiError } from '@/lib/api';
import { useLiveUpdates, type LiveEvent } from '@/lib/live-updates';
import type { ConversationPage, Me, Scope } from '@/lib/types';
import { useNow } from '@/lib/use-now';
import { ConversationList } from './conversation-list';
import { ConversationViewPane } from './conversation-view';
import { LocaleSwitcher } from './locale-switcher';
import { Avatar } from './ui/avatar';
import { Badge, type Tone } from './ui/badge';
import { BrandMark } from './ui/brand';
import { Button } from './ui/button';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';

const SCOPES: Scope[] = ['waiting', 'mine', 'all', 'closed'];

const CONNECTION_TONE: Record<string, Tone> = {
  live: 'success',
  connecting: 'warning',
  reconnecting: 'warning',
  polling: 'danger',
};

function beep(): void {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 880;
    oscillator.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.15);
  } catch {
    // No audio permission: the visual cues remain.
  }
}

export function InboxApp(): ReactNode {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const scopeParam = params.get('scope') as Scope | null;
  const scope: Scope =
    scopeParam && SCOPES.includes(scopeParam) ? scopeParam : 'waiting';
  const selected = params.get('c');
  const [sound, setSound] = useState(true);
  const soundRef = useRef(sound);
  soundRef.current = sound;

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/api/v1/auth/me'),
    retry: false,
  });
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401)
      router.replace('/login');
  }, [me.error, router]);

  const tRef = useRef(t);
  tRef.current = t;
  const onEvent = useCallback((event: LiveEvent) => {
    if (event.type !== 'handover.created') return;
    if (soundRef.current) beep();
    if (
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    )
      new Notification(tRef.current('notify.newHandover'), { tag: 'handover' });
  }, []);

  const connection = useLiveUpdates(me.isSuccess, onEvent);

  const waiting = useQuery({
    queryKey: ['conversations', 'waiting-count'],
    queryFn: () =>
      api<ConversationPage>(
        '/api/v1/inbox/conversations?scope=waiting&limit=50',
      ),
    enabled: me.isSuccess,
  });
  const waitingCount = waiting.data?.items.length ?? 0;
  const now = useNow();
  const overdue = (waiting.data?.items ?? []).filter(
    (item) => item.slaDueAt && Date.parse(item.slaDueAt) < now,
  ).length;

  useEffect(() => {
    document.title = `${waitingCount > 0 ? `(${waitingCount}) ` : ''}${t('app.title')} · ${t('app.brand')}`;
  }, [waitingCount, t]);

  function navigate(next: { scope?: Scope; c?: string | null }): void {
    const search = new URLSearchParams(params.toString());
    if (next.scope) search.set('scope', next.scope);
    if (next.c === null) search.delete('c');
    else if (next.c) search.set('c', next.c);
    router.push(`/inbox?${search.toString()}`);
  }

  async function logout(): Promise<void> {
    try {
      await api('/api/v1/auth/logout', { method: 'POST' });
    } finally {
      queryClient.clear();
      router.replace('/login');
    }
  }

  if (me.isPending) {
    return (
      <div className="flex h-dvh flex-col" role="status">
        <span className="sr-only">{t('app.loading')}</span>
        <SkeletonRows rows={6} />
      </div>
    );
  }
  if (me.isError || !me.data.operator) {
    return me.error instanceof ApiError && me.error.status === 401 ? null : (
      <div className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-4 px-4 text-center">
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
        >
          <Icon name="alert" />
          {t('errors.UNKNOWN')}
        </p>
        <Button variant="primary" onClick={() => void me.refetch()}>
          {t('app.retry')}
        </Button>
      </div>
    );
  }
  const operator = me.data.operator;
  const timeZone = me.data.tenant?.timezone;

  return (
    <div className="flex h-dvh flex-col">
      <a
        href="#inbox-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop"
      >
        {t('app.skip')}
      </a>
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line bg-surface px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <BrandMark className="h-8 w-9 shrink-0" />
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="text-lg font-extrabold tracking-tight text-brand italic">
              {t('app.brand')}
            </span>
            <h1 className="truncate text-xs text-muted">{t('app.title')}</h1>
          </div>
          <span data-testid="connection" data-state={connection}>
            <Badge tone={CONNECTION_TONE[connection] ?? 'neutral'} dot>
              {t(`connection.${connection}`)}
            </Badge>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-sm sm:gap-2">
          <Button
            size="sm"
            variant="ghost"
            icon={sound ? 'volume' : 'volumeOff'}
            aria-pressed={sound}
            onClick={() => setSound(!sound)}
          >
            <span className="sr-only md:not-sr-only">
              {sound ? t('header.soundOn') : t('header.soundOff')}
            </span>
          </Button>
          {typeof Notification !== 'undefined' &&
          Notification.permission === 'default' ? (
            <Button
              size="sm"
              variant="ghost"
              icon="bell"
              onClick={() => void Notification.requestPermission()}
            >
              <span className="sr-only md:not-sr-only">
                {t('header.notifications')}
              </span>
            </Button>
          ) : null}
          <LocaleSwitcher />
          <span className="flex items-center gap-2 rounded-lg border border-line px-2 py-1">
            <Avatar name={operator.displayName} size="sm" />
            <span
              data-testid="operator"
              className="sr-only text-sm lg:not-sr-only"
            >
              {t('header.signedInAs', {
                name: operator.displayName,
                role: t(`role.${operator.role}`),
              })}
            </span>
          </span>
          <Button
            size="sm"
            variant="secondary"
            icon="logout"
            onClick={() => void logout()}
          >
            <span className="sr-only sm:not-sr-only">{t('header.logout')}</span>
          </Button>
        </div>
      </header>
      {overdue > 0 ? (
        <div
          role="alert"
          data-testid="sla-banner"
          className="flex shrink-0 items-center gap-2 bg-warning-soft px-4 py-2 text-sm font-medium text-warning-fg"
        >
          <Icon name="clock" />
          {t('banner.sla', { count: overdue })}
        </div>
      ) : null}
      <main
        id="inbox-main"
        className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(19rem,23rem)_1fr]"
      >
        <section
          aria-label={t('list.region')}
          className={`${selected ? 'hidden md:flex' : 'flex'} min-h-0 flex-col border-r border-line bg-surface`}
        >
          <ConversationList
            scope={scope}
            selectedId={selected}
            timeZone={timeZone}
            waitingCount={waitingCount}
            onScope={(next) => navigate({ scope: next, c: null })}
            onSelect={(id) => navigate({ c: id })}
          />
        </section>
        <section
          className={`${selected ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-col`}
        >
          {selected ? (
            <ConversationViewPane
              id={selected}
              me={{ id: operator.id, role: operator.role }}
              timeZone={timeZone}
              onBack={() => navigate({ c: null })}
            />
          ) : (
            <div className="grid flex-1 place-items-center p-6">
              <div className="flex max-w-xs flex-col items-center gap-3 text-center text-muted">
                <span className="grid h-14 w-14 place-items-center rounded-2xl bg-surface-2">
                  <Icon name="message" className="h-7 w-7" />
                </span>
                <p>{t('view.select')}</p>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
