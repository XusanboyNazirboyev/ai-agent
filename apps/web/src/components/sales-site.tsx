'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import {
  planLimitLines,
  safeContactUrl,
  signupHref,
  type PublicPlans,
} from '@/lib/public-site';
import { LegalLinks } from './legal-page';
import { LocaleSwitcher } from './locale-switcher';
import { BrandLogo } from './ui/brand';
import { Icon } from './ui/icons';

const CTA =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-5 py-2.5 text-center font-semibold text-primary-fg hover:bg-primary-hover';
const CARD =
  'flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-card';

/** A signed-in person goes to the app; a visitor stays on the sales page. */
function useSessionRedirect(): void {
  const router = useRouter();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<unknown>('/api/v1/auth/me'),
    retry: false,
  });
  useEffect(() => {
    if (me.isSuccess) router.replace('/today');
  }, [me.isSuccess, router]);
}

export function SalesSite(): ReactNode {
  const { t, locale } = useI18n();
  useSessionRedirect();
  const plans = useQuery({
    queryKey: ['public-plans'],
    queryFn: () => api<PublicPlans>('/api/v1/public/plans'),
    retry: false,
    staleTime: 60_000,
  });
  const list = plans.data?.plans ?? [];
  const contact = safeContactUrl(
    plans.data?.contactUrl,
    process.env.NEXT_PUBLIC_SALES_CONTACT_URL,
  );
  const steps = [1, 2, 3];
  const features = [1, 2, 3, 4];
  return (
    <div className="min-h-dvh overflow-x-hidden bg-canvas text-fg">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-4">
        <Link href="/" aria-label={t('app.brand')}>
          <BrandLogo name={t('app.brand')} className="text-2xl" />
        </Link>
        <nav aria-label={t('site.nav')} className="flex items-center gap-3">
          <LocaleSwitcher />
          <Link href="/login" className="text-sm font-medium underline">
            {t('site.signIn')}
          </Link>
        </nav>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-14 px-4 pb-12">
        <section className="flex flex-col items-start gap-5 pt-6">
          <h1 className="text-3xl leading-tight font-semibold tracking-tight sm:text-5xl">
            {t('site.hero.title')}
          </h1>
          <p className="max-w-2xl text-base text-muted sm:text-lg">
            {t('site.hero.subtitle')}
          </p>
          <Link href={signupHref()} className={CTA} data-testid="site-cta">
            {t('site.cta')}
          </Link>
          <p className="text-sm text-muted">{t('site.hero.note')}</p>
        </section>

        <section
          aria-labelledby="site-features"
          className="flex flex-col gap-5"
        >
          <h2 id="site-features" className="text-2xl font-semibold">
            {t('site.features.title')}
          </h2>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {features.map((n) => (
              <li key={n} className={CARD}>
                <h3 className="font-semibold">{t(`site.feature${n}.title`)}</h3>
                <p className="text-sm text-muted">
                  {t(`site.feature${n}.body`)}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="site-steps" className="flex flex-col gap-5">
          <h2 id="site-steps" className="text-2xl font-semibold">
            {t('site.steps.title')}
          </h2>
          <ol className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {steps.map((n) => (
              <li key={n} className={CARD}>
                <span className="grid h-8 w-8 place-items-center rounded-full bg-primary-soft font-semibold text-brand">
                  {n}
                </span>
                <h3 className="font-semibold">{t(`site.step${n}.title`)}</h3>
                <p className="text-sm text-muted">{t(`site.step${n}.body`)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="site-plans" className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h2 id="site-plans" className="text-2xl font-semibold">
              {t('site.plans.title')}
            </h2>
            <p className="text-sm text-muted">{t('site.plans.subtitle')}</p>
          </div>
          {plans.isPending ? (
            <p role="status" className="text-sm text-muted">
              {t('site.plans.loading')}
            </p>
          ) : null}
          <ul
            data-testid="site-plans"
            className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
          >
            {list.map((plan) => {
              const price = formatMoney(
                Number(plan.priceMinor),
                plan.currency,
                locale,
              );
              return (
                <li
                  key={plan.code}
                  data-testid="site-plan"
                  data-code={plan.code}
                  className={CARD}
                >
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  <p className="text-2xl font-semibold">
                    {plan.periodDays === 30
                      ? t('site.plans.perMonth', { price })
                      : t('site.plans.perPeriod', {
                          price,
                          days: plan.periodDays,
                        })}
                  </p>
                  <ul className="flex flex-1 flex-col gap-2 text-sm">
                    {planLimitLines(plan.limits).map((line) => (
                      <li key={line.key} className="flex items-start gap-2">
                        <Icon
                          name="check"
                          className="mt-0.5 h-4 w-4 shrink-0 text-brand"
                        />
                        {t(line.key, { count: line.count })}
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-muted">{t('site.plans.free')}</p>
                  <Link
                    href={signupHref(plan.code)}
                    className={CTA}
                    aria-label={t('site.plans.choose', { name: plan.name })}
                  >
                    {t('site.cta')}
                  </Link>
                </li>
              );
            })}
            <li data-testid="site-enterprise" className={CARD}>
              <h3 className="text-lg font-semibold">
                {t('site.enterprise.name')}
              </h3>
              <p className="text-2xl font-semibold">
                {t('site.enterprise.price')}
              </p>
              <p className="flex-1 text-sm text-muted">
                {t('site.enterprise.body')}
              </p>
              {contact ? (
                <a
                  href={contact}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="site-contact"
                  className={CTA}
                >
                  {t('site.enterprise.contact')}
                </a>
              ) : null}
            </li>
          </ul>
          {list.length === 0 && !plans.isPending ? (
            <div>
              <Link href={signupHref()} className={CTA}>
                {t('site.cta')}
              </Link>
            </div>
          ) : null}
        </section>

        <section aria-labelledby="site-faq" className="flex flex-col gap-4">
          <h2 id="site-faq" className="text-2xl font-semibold">
            {t('site.faq.title')}
          </h2>
          <div className="flex flex-col gap-3">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <details key={n} className={CARD}>
                <summary className="cursor-pointer font-semibold">
                  {t(`site.faq${n}.q`)}
                </summary>
                <p className="pt-2 text-sm text-muted">{t(`site.faq${n}.a`)}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
      <footer className="mx-auto flex w-full max-w-5xl flex-col gap-3 border-t border-line px-4 py-6">
        <LegalLinks />
        <Link href="/login" className="text-sm underline">
          {t('site.footer.signIn')}
        </Link>
      </footer>
    </div>
  );
}
