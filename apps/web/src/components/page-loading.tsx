'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { SkeletonRows } from './ui/skeleton';

/**
 * Shown by the route `loading.tsx` files: a click switches to the new page at
 * once and shows this while the server answer is on its way (ADR 083).
 */
export function PageLoading(): ReactNode {
  const { t } = useI18n();
  return (
    <div role="status" data-testid="page-loading" className="flex flex-col">
      <span className="sr-only">{t('app.loading')}</span>
      <SkeletonRows rows={6} />
    </div>
  );
}
