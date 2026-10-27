'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { Button, buttonClass } from '@/components/ui/button';
import { StatusScreen } from '@/components/ui/status-screen';

export default function ErrorPage(props: { reset: () => void }): ReactNode {
  const { t } = useI18n();
  return (
    <StatusScreen
      code="500"
      title={t('errorPage.title')}
      body={t('errorPage.body')}
    >
      <Button variant="primary" onClick={props.reset}>
        {t('app.retry')}
      </Button>
      <Link href="/inbox" className={buttonClass('secondary')}>
        {t('notfound.back')}
      </Link>
    </StatusScreen>
  );
}
