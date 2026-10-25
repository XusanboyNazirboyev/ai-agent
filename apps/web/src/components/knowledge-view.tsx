'use client';

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { DocumentsPanel } from './documents-panel';
import { FaqPanel } from './knowledge-page';

type Tab = 'faq' | 'documents';
const TABS: Tab[] = ['faq', 'documents'];

/** The knowledge base: FAQ entries and uploaded documents, in two tabs. */
export function KnowledgeView(): ReactNode {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('faq');
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKey(event: KeyboardEvent, index: number): void {
    const target =
      event.key === 'ArrowRight'
        ? (index + 1) % TABS.length
        : event.key === 'ArrowLeft'
          ? (index + TABS.length - 1) % TABS.length
          : -1;
    if (target < 0) return;
    event.preventDefault();
    setTab(TABS[target]);
    refs.current[TABS[target]]?.focus();
  }

  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('nav.knowledge')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 sm:p-6">
        <p className="text-sm text-muted">{t('knowledge.intro')}</p>
        <div
          role="tablist"
          aria-label={t('knowledge.tabs')}
          className="flex gap-1 self-start rounded-xl bg-surface-2 p-1"
        >
          {TABS.map((id, index) => (
            <button
              key={id}
              ref={(node) => {
                refs.current[id] = node;
              }}
              type="button"
              role="tab"
              id={`knowledge-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`knowledge-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              data-testid={`knowledge-tab-${id}`}
              onClick={() => setTab(id)}
              onKeyDown={(event) => onKey(event, index)}
              className={`min-h-9 rounded-lg px-4 text-sm font-medium transition-colors ${
                tab === id
                  ? 'bg-surface text-fg shadow-card'
                  : 'text-muted hover:text-fg'
              }`}
            >
              {t(`knowledgeTab.${id}`)}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`knowledge-panel-${tab}`}
          aria-labelledby={`knowledge-tab-${tab}`}
          className="min-w-0"
        >
          {tab === 'faq' ? <FaqPanel /> : <DocumentsPanel />}
        </div>
      </div>
    </div>
  );
}
