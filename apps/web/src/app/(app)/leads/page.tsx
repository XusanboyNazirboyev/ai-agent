import type { ReactNode } from 'react';
import { CrmSubPage } from '@/components/crm-section-nav';
import { LeadsPage as LeadsHomePage } from '@/components/leads-page';

export default function LeadsPage(): ReactNode {
  return (
    <CrmSubPage active="leads">
      <LeadsHomePage />
    </CrmSubPage>
  );
}
