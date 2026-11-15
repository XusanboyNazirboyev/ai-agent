import type { ReactNode } from 'react';
import { KnowledgeView } from '@/components/knowledge-view';
import { SettingsSubPage } from '@/components/settings-section-nav';

/** The knowledge base is part of the Assistant group of Settings (UX review A3). */
export default function Knowledge(): ReactNode {
  return (
    <SettingsSubPage active="knowledge">
      <KnowledgeView />
    </SettingsSubPage>
  );
}
