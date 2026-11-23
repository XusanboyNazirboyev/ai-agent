import type { ReactNode } from 'react';
import { AgentSubPage } from '@/components/agent-section-nav';
import { BotPage } from '@/components/bot-page';

export default function AgentDashboard(): ReactNode {
  return (
    <AgentSubPage active="dashboard">
      <BotPage />
    </AgentSubPage>
  );
}
