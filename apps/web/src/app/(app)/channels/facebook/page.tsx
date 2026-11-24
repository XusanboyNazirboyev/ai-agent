import type { ReactNode } from 'react';
import { ChannelsPage } from '@/components/channels-page';
import { ChannelsSubPage } from '@/components/channels-section-nav';

export default function Channels(): ReactNode {
  return (
    <ChannelsSubPage active="facebook">
      <ChannelsPage only="facebook" />
    </ChannelsSubPage>
  );
}
