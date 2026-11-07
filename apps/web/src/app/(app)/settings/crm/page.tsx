import type { ReactNode } from 'react';
import { CrmPage } from '@/components/crm-page';
import { SettingsSubPage } from '@/components/settings-section-nav';

export default function CrmSettings(): ReactNode {
  return (
    <SettingsSubPage active="crm">
      <CrmPage />
    </SettingsSubPage>
  );
}
