import type { ReactNode } from 'react';
import { CallsPage } from '@/components/calls-page';
import { SettingsSubPage } from '@/components/settings-section-nav';

export default function TelephonySettings(): ReactNode {
  return (
    <SettingsSubPage active="telephony">
      <CallsPage settings />
    </SettingsSubPage>
  );
}
