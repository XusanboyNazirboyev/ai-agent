import type { ReactNode } from 'react';
import { AgentSubPage } from '@/components/agent-section-nav';
import { KnowledgeView } from '@/components/knowledge-view';

export default function AgentKnowledge(): ReactNode {
  return (
    <AgentSubPage active="knowledge">
      <KnowledgeView />
    </AgentSubPage>
  );
}
