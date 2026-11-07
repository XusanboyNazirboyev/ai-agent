import type { ReactNode } from 'react';
import { BotPage } from '@/components/bot-page';
import { SettingsSubPage } from '@/components/settings-section-nav';

export default function BotSettings(): ReactNode {
  return (
    <SettingsSubPage active="bot">
      <BotPage />
    </SettingsSubPage>
  );
}
