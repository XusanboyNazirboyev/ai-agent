import type { ReactNode } from 'react';
import { AgentSubPage } from '@/components/agent-section-nav';
import { AgentRulesPage } from '@/components/agent-rules-page';

export default function AgentRules(): ReactNode {
  return (
    <AgentSubPage active="rules">
      <AgentRulesPage />
    </AgentSubPage>
  );
}
