import type { ReactNode } from 'react';
import { ChannelsPage } from '@/components/channels-page';
import { SettingsSubPage } from '@/components/settings-section-nav';

export default function ChannelSettings(): ReactNode {
  return (
    <SettingsSubPage active="channels">
      <ChannelsPage />
    </SettingsSubPage>
  );
}
