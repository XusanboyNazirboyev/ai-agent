'use client';

import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { useI18n, type Locale } from '@/i18n';
import {
  LEGAL_DETAILS,
  LEGAL_UPDATED,
  type LegalDocument,
} from '@/content/legal';
import { LocaleSwitcher } from './locale-switcher';
import { BrandLogo } from './ui/brand';

const TOKEN = /\{(company|address|email|retention|deletionDays)\}/g;

/** Replaces `{company}`-style tokens; an unknown detail shows a placeholder. */
function Filled(props: { text: string; placeholder: string }): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of props.text.matchAll(TOKEN)) {
    const key = match[1] as keyof typeof LEGAL_DETAILS;
    parts.push(props.text.slice(last, match.index));
    const value = LEGAL_DETAILS[key];
    parts.push(
      value ?? (
        <mark
          key={`${key}-${match.index}`}
          data-testid="legal-placeholder"
          className="rounded bg-warning-soft px-1 text-warning-fg"
        >
          {props.placeholder}
        </mark>
      ),
    );
    last = (match.index ?? 0) + match[0].length;
  }
  parts.push(props.text.slice(last));
  return <>{parts}</>;
}

/** A public, signed-out page: the privacy policy or data deletion steps. */
export function LegalPage(props: {
  documents: Record<Locale, LegalDocument>;
  testId: string;
}): ReactNode {
  const { t, locale } = useI18n();
  const doc = props.documents[locale];
  const placeholder = t('legal.placeholder');
  return (
    <main
      data-testid={props.testId}
      className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-4 py-8 text-fg"
    >
      <header className="flex items-center justify-between gap-4">
        <Link href="/login" aria-label={t('app.brand')}>
          <BrandLogo name={t('app.brand')} className="text-2xl" />
        </Link>
        <LocaleSwitcher />
      </header>
      <p
        role="note"
        className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-fg"
      >
        {t('legal.draft')}
      </p>
      <article className="flex flex-col gap-5">
        <h1 className="text-3xl font-semibold">{doc.title}</h1>
        {doc.intro.map((text, index) => (
          <p key={index} className="leading-relaxed">
            <Filled text={text} placeholder={placeholder} />
          </p>
        ))}
        {doc.sections.map((section) => (
          <section key={section.heading} className="flex flex-col gap-2">
            <h2 className="text-xl font-semibold">{section.heading}</h2>
            {section.body.map((part, index) => (
              <Fragment key={index}>
                {typeof part === 'string' ? (
                  <p className="leading-relaxed">
                    <Filled text={part} placeholder={placeholder} />
                  </p>
                ) : (
                  <ul className="flex list-disc flex-col gap-1 pl-6 leading-relaxed">
                    {part.map((item) => (
                      <li key={item}>
                        <Filled text={item} placeholder={placeholder} />
                      </li>
                    ))}
                  </ul>
                )}
              </Fragment>
            ))}
          </section>
        ))}
        <p className="text-sm text-muted">
          {t('legal.updated', { date: LEGAL_UPDATED })}
        </p>
      </article>
      <LegalLinks />
    </main>
  );
}

/** Links to both public pages (footer of the login and legal pages). */
export function LegalLinks(): ReactNode {
  const { t } = useI18n();
  return (
    <nav
      aria-label={t('legal.nav')}
      className="flex flex-wrap gap-4 text-sm text-muted"
    >
      <Link href="/privacy" className="underline hover:text-fg">
        {t('legal.privacy')}
      </Link>
      <Link href="/data-deletion" className="underline hover:text-fg">
        {t('legal.dataDeletion')}
      </Link>
    </nav>
  );
}
