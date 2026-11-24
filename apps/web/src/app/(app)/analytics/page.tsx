import type { ReactNode } from 'react';
import { CrmSubPage } from '@/components/crm-section-nav';
import { AnalyticsPage } from '@/components/analytics-page';

export default function Analytics(): ReactNode {
  return (
    <CrmSubPage active="report">
      <AnalyticsPage />
    </CrmSubPage>
  );
}
