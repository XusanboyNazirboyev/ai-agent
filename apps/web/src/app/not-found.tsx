'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { StatusScreen } from '@/components/ui/status-screen';
import { buttonClass } from '@/components/ui/button';

export default function NotFound(): ReactNode {
  const { t } = useI18n();
  return (
    <StatusScreen
      code="404"
      title={t('notfound.title')}
      body={t('notfound.body')}
    >
      <Link href="/inbox" className={buttonClass('primary')}>
        {t('notfound.back')}
      </Link>
    </StatusScreen>
  );
}
