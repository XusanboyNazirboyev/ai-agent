'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { platformApi } from '@/lib/api';
import { MfaSecurityPanel } from '../mfa';

/** Console → Security (ADR 048 §7): the second factor of the signed-in admin. */
export function ConsoleSecurity(): ReactNode {
  const { t } = useI18n();
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-3 sm:p-6">
      <h1 className="text-lg font-semibold">{t('mfa.security.title')}</h1>
      <MfaSecurityPanel
        call={platformApi}
        prefix="/api/v1/platform/auth/mfa"
        queryKey={['platform', 'mfa']}
      />
    </div>
  );
}
