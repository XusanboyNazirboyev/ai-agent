import type { ReactNode } from 'react';
import { CallsPage } from '@/components/calls-page';
import { CrmSubPage } from '@/components/crm-section-nav';

export default function Calls(): ReactNode {
  return (
    <CrmSubPage active="calls">
      <CallsPage />
    </CrmSubPage>
  );
}
