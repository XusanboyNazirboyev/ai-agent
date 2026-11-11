'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { useShell } from './app-shell';
import { MfaSecurityPanel } from './mfa';
import { SettingsSubPage } from './settings-section-nav';

/** Settings → Security (ADR 048 §7): two-step sign-in for the signed-in operator. */
export function SecurityPage(): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const recommended = operator.role === 'OWNER' || operator.role === 'ADMIN';
  return (
    <SettingsSubPage active="security">
      <div
        role="region"
        tabIndex={0}
        aria-label={t('settings.section.security')}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-3 sm:p-6">
          <h2 className="text-lg font-semibold">{t('mfa.security.title')}</h2>
          {recommended ? (
            <p role="note" className="text-sm text-muted">
              {t('mfa.security.recommended')}
            </p>
          ) : null}
          <MfaSecurityPanel
            call={api}
            prefix="/api/v1/auth/mfa"
            queryKey={['mfa', 'tenant']}
          />
        </div>
      </div>
    </SettingsSubPage>
  );
}
