'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { ContactsPage } from './contacts-page';
import { LeadsBoard } from './leads-board';

type View = 'list' | 'funnel';

export function LeadsPage(): ReactNode {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const view: View = params.get('view') === 'funnel' ? 'funnel' : 'list';

  function choose(next: View): void {
    router.replace(`/leads?view=${next}`, { scroll: false });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label={t('leads.views')}
        className="flex shrink-0 gap-1 border-b border-line bg-surface px-3 py-2 sm:px-4"
      >
        {(['list', 'funnel'] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={view === item}
            onClick={() => choose(item)}
            className={`min-h-10 rounded-lg px-4 text-sm font-medium transition-colors ${
              view === item
                ? 'bg-primary-soft text-primary-fg'
                : 'text-muted hover:bg-surface-2 hover:text-fg'
            }`}
          >
            {t(`leads.view.${item}`)}
          </button>
        ))}
      </div>
      {view === 'list' ? <ContactsPage /> : <LeadsBoard />}
    </div>
  );
}
