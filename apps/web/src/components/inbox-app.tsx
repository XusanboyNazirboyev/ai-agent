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

const SCOPES: Scope[] = ['waiting', 'mine', 'all', 'closed'];

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
    document.title = `${waitingCount > 0 ? `(${waitingCount}) ` : ''}${t('app.title')}`;
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
    return <p className="p-6">{t('app.loading')}</p>;
  }
  if (me.isError || !me.data.operator) {
    return me.error instanceof ApiError && me.error.status === 401 ? null : (
      <div className="p-6">
        <p role="alert">{t('errors.UNKNOWN')}</p>
        <button className="underline" onClick={() => void me.refetch()}>
          {t('app.retry')}
        </button>
      </div>
    );
  }
  const operator = me.data.operator;
  const timeZone = me.data.tenant?.timezone;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-700 dark:bg-slate-900">
        <h1 className="text-lg font-semibold">{t('app.title')}</h1>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span
            data-testid="connection"
            data-state={connection}
            className="rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800"
          >
            {t(`connection.${connection}`)}
          </span>
          <button
            type="button"
            className="underline"
            aria-pressed={sound}
            onClick={() => setSound(!sound)}
          >
            {sound ? t('header.soundOn') : t('header.soundOff')}
          </button>
          {typeof Notification !== 'undefined' &&
          Notification.permission === 'default' ? (
            <button
              type="button"
              className="underline"
              onClick={() => void Notification.requestPermission()}
            >
              {t('header.notifications')}
            </button>
          ) : null}
          <span data-testid="operator">
            {t('header.signedInAs', {
              name: operator.displayName,
              role: t(`role.${operator.role}`),
            })}
          </span>
          <LocaleSwitcher />
          <button
            type="button"
            className="underline"
            onClick={() => void logout()}
          >
            {t('header.logout')}
          </button>
        </div>
      </header>
      {overdue > 0 ? (
        <div
          role="alert"
          data-testid="sla-banner"
          className="bg-amber-100 px-4 py-2 text-sm text-amber-900 dark:bg-amber-900 dark:text-amber-100"
        >
          {t('banner.sla', { count: overdue })}
        </div>
      ) : null}
      <main className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[22rem_1fr]">
        <section
          className={`${selected ? 'hidden md:flex' : 'flex'} min-h-0 flex-col border-r border-slate-200 dark:border-slate-700`}
        >
          <ConversationList
            scope={scope}
            selectedId={selected}
            timeZone={timeZone}
            onScope={(next) => navigate({ scope: next, c: null })}
            onSelect={(id) => navigate({ c: id })}
          />
        </section>
        <section
          className={`${selected ? 'flex' : 'hidden md:flex'} min-h-0 flex-col`}
        >
          {selected ? (
            <ConversationViewPane
              id={selected}
              me={{ id: operator.id, role: operator.role }}
              timeZone={timeZone}
              onBack={() => navigate({ c: null })}
            />
          ) : (
            <p className="p-6 text-slate-600 dark:text-slate-400">
              {t('view.select')}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
