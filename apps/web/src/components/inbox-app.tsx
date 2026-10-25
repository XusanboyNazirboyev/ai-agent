'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import type { Scope } from '@/lib/types';
import { useShell } from './app-shell';
import { ConversationList } from './conversation-list';
import { ConversationViewPane } from './conversation-view';
import { Icon } from './ui/icons';

const SCOPES: Scope[] = ['waiting', 'mine', 'all', 'closed'];

/** Conversation list beside the open conversation (one at a time on phones). */
export function InboxApp(): ReactNode {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const { operator, timeZone, waitingCount } = useShell();
  const scopeParam = params.get('scope') as Scope | null;
  const scope: Scope =
    scopeParam && SCOPES.includes(scopeParam) ? scopeParam : 'waiting';
  const selected = params.get('c');

  function navigate(next: { scope?: Scope; c?: string | null }): void {
    const search = new URLSearchParams(params.toString());
    if (next.scope) search.set('scope', next.scope);
    if (next.c === null) search.delete('c');
    else if (next.c) search.set('c', next.c);
    router.push(`/inbox?${search.toString()}`);
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
      <section
        aria-label={t('list.region')}
        className={`${selected ? 'hidden md:flex' : 'flex'} min-h-0 min-w-0 flex-col border-r border-line bg-surface`}
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
    </div>
  );
}
