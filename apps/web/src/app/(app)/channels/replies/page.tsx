import type { ReactNode } from 'react';
import { ChannelsSubPage } from '@/components/channels-section-nav';
import { RepliesSettingsPage } from '@/components/replies-settings-page';

export default function Replies(): ReactNode {
  return (
    <ChannelsSubPage active="replies">
      <RepliesSettingsPage />
    </ChannelsSubPage>
  );
}
