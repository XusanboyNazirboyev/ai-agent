'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import {
  notificationState,
  type NotificationState,
} from '@/lib/browser-notify';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

/**
 * Browser notifications: shows on / blocked / not supported, and asks for
 * permission only on a click. Read after hydration (SSR has no Notification).
 */
export function NotificationControl(): ReactNode {
  const { t } = useI18n();
  const [state, setState] = useState<NotificationState>('unsupported');
  useEffect(() => setState(notificationState()), []);
  async function enable(): Promise<void> {
    try {
      await Notification.requestPermission();
    } catch {
      // Older browsers use a callback form; the state below is re-read anyway.
    }
    setState(notificationState());
  }
  return (
    <span
      data-testid="notification-control"
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <span className="font-medium">{t('settings.browserAlerts')}</span>
      <Badge
        tone={
          state === 'granted'
            ? 'success'
            : state === 'denied'
              ? 'danger'
              : 'neutral'
        }
        dot
      >
        {t(`permission.${state}`)}
      </Badge>
      {state === 'default' ? (
        <Button size="sm" icon="bell" onClick={() => void enable()}>
          {t('header.notifications')}
        </Button>
      ) : null}
    </span>
  );
}
