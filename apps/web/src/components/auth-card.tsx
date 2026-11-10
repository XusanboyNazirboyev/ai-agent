'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { LocaleSwitcher } from './locale-switcher';
import { BrandLogo } from './ui/brand';

/** Centered sign-in style card (console sign-in, invite acceptance). */
export function AuthCard(props: {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  children: ReactNode;
}): ReactNode {
  const { t } = useI18n();
  return (
    <main className="flex min-h-dvh flex-col bg-canvas px-4 py-6 sm:px-8">
      <div className="flex justify-end">
        <LocaleSwitcher />
      </div>
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6">
        <div className="flex flex-col gap-2">
          <span className="flex flex-wrap items-center gap-2">
            <BrandLogo name={t('app.brand')} />
            {props.badge}
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">
            {props.title}
          </h1>
          {props.subtitle ? (
            <p className="text-sm text-muted">{props.subtitle}</p>
          ) : null}
        </div>
        {props.children}
      </div>
    </main>
  );
}
