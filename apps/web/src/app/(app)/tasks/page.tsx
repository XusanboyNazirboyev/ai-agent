import type { ReactNode } from 'react';
import { CrmSubPage } from '@/components/crm-section-nav';
import { TasksPage } from '@/components/tasks-page';

export default function Tasks(): ReactNode {
  return (
    <CrmSubPage active="tasks">
      <TasksPage />
    </CrmSubPage>
  );
}
