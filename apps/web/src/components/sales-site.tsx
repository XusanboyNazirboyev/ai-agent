'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import {
  planLimitLines,
  safeContactUrl,
  signupHref,
  type PublicPlans,
} from '@/lib/public-site';
import { SITE_CLIENTS } from '@/lib/site-clients';
import { LegalLinks } from './legal-page';
import { LocaleSwitcher } from './locale-switcher';
import { SiteChatDemo } from './site-chat-demo';
import { SiteContactForm } from './site-contact-form';
import { BrandLogo } from './ui/brand';
import { Button } from './ui/button';
import { Icon } from './ui/icons';

const CTA =
  'inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-center font-semibold text-white transition-colors hover:bg-primary-hover';
const CTA_SECONDARY =
  'inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-line bg-surface px-5 py-2.5 text-center font-semibold text-fg transition-colors hover:bg-surface-2';
const CARD =
  'flex min-w-0 flex-col gap-3 rounded-2xl border border-line p-6 sm:p-7';
const CONTAINER = 'mx-auto w-full max-w-7xl px-4 sm:px-8 lg:px-12';
const HEADING = 'text-3xl font-semibold tracking-tight sm:text-5xl';
const FEATURE_ICONS = ['globe', 'chart', 'users', 'clock'] as const;

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
  const [visiblePlanCount, setVisiblePlanCount] = useState(6);
  const visiblePlans = list.slice(0, visiblePlanCount);
  const contact = safeContactUrl(
    plans.data?.contactUrl,
    process.env.NEXT_PUBLIC_SALES_CONTACT_URL,
  );
  const video = safeContactUrl(plans.data?.videoUrl, undefined);
  const steps = [1, 2, 3];
  const results = [1, 2, 3, 4];
  return (
    <div className="min-h-dvh bg-surface text-fg">
      <header className="border-b border-line">
        <div
          className={`${CONTAINER} grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 pt-3 lg:grid-cols-[1fr_auto_1fr] lg:py-4`}
        >
          <Link
            href="/"
            aria-label={t('app.brand')}
            className="justify-self-start rounded-lg"
          >
            <BrandLogo name={t('app.brand')} />
          </Link>
          <nav
            aria-label={t('site.nav')}
            className="col-span-2 row-start-2 flex flex-wrap items-center gap-x-5 text-sm font-semibold text-muted lg:col-span-1 lg:col-start-2 lg:row-start-1 lg:gap-x-8"
          >
            <a
              href="#product"
              className="flex min-h-11 items-center hover:text-brand"
            >
              {t('site.nav.product')}
            </a>
            <a
              href="#pricing"
              className="flex min-h-11 items-center hover:text-brand"
            >
              {t('site.plans.title')}
            </a>
            <a
              href="#faq"
              className="flex min-h-11 items-center hover:text-brand"
            >
              {t('site.nav.faq')}
            </a>
          </nav>
          <div className="col-start-2 row-start-1 flex items-center justify-self-end gap-2 lg:col-start-3">
            <LocaleSwitcher compact />
            <Link
              href="/login"
              className="flex min-h-11 items-center rounded-lg px-2 text-sm font-semibold hover:text-brand"
            >
              {t('site.signIn')}
            </Link>
          </div>
        </div>
      </header>
      <main>
        <section className="bg-[#0b142b] bg-[radial-gradient(ellipse_at_86%_18%,#203f82_0%,transparent_58%)] text-white">
          <div
            className={`${CONTAINER} grid items-center gap-9 py-12 sm:gap-12 sm:py-20 lg:grid-cols-[minmax(0,1.18fr)_minmax(0,1fr)] lg:py-24`}
          >
            <div className="flex flex-col items-start gap-5 sm:gap-7">
              <p className="flex items-center gap-2 text-sm font-semibold text-blue-200">
                <Icon name="bolt" className="h-4 w-4" />
                {t('site.hero.eyebrow')}
              </p>
              <h1 className="text-[clamp(2.375rem,5vw,4.625rem)] leading-[1.05] font-semibold tracking-[-0.045em] text-balance">
                {t('site.hero.title')}{' '}
                <span className="block text-blue-200">
                  {t('site.hero.accent')}
                </span>
              </h1>
              <p className="max-w-lg text-base leading-relaxed text-slate-200 sm:text-lg">
                {t('site.hero.subtitle')}
              </p>
              <div className="flex w-full flex-wrap gap-3 max-sm:[&>*]:w-full">
                <Link
                  href={signupHref()}
                  className={CTA}
                  data-testid="site-cta"
                >
                  {t('site.cta')}
                  <Icon name="chevronRight" className="h-4 w-4 shrink-0" />
                </Link>
                <a
                  href="#contact"
                  className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/35 px-5 py-2.5 text-center font-semibold text-white transition-colors hover:bg-white/10"
                >
                  {t('site.contact.cta')}
                </a>
              </div>
              <p className="text-sm text-slate-200">{t('site.hero.note')}</p>
            </div>
            <div className="min-w-0 rounded-[1.875rem] border border-white/20 bg-white/10 p-2.5 text-fg shadow-2xl sm:p-3">
              {video ? (
                <video
                  data-testid="site-video"
                  src={video}
                  autoPlay
                  muted
                  loop
                  playsInline
                  controls
                  preload="metadata"
                  aria-label={t('site.demo.video')}
                  className="aspect-[9/16] max-h-[32rem] w-full rounded-3xl bg-[#0b142b] object-contain"
                />
              ) : (
                <SiteChatDemo />
              )}
            </div>
          </div>
        </section>

        <div
          className={`${CONTAINER} flex flex-col gap-16 py-16 sm:gap-24 sm:py-24`}
        >
          <section
            id="product"
            aria-labelledby="site-features"
            className="grid scroll-mt-6 gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-14"
          >
            <h2
              id="site-features"
              className={`${HEADING} max-w-[14ch] text-balance`}
            >
              {t('site.features.title')}
            </h2>
            <ul className="grid overflow-hidden rounded-3xl border border-line bg-canvas sm:grid-cols-2">
              {FEATURE_ICONS.map((icon, index) => (
                <li
                  key={icon}
                  className="flex min-w-0 flex-col items-start gap-3 border-line p-6 not-last:border-b sm:p-8 sm:even:border-l sm:nth-[3]:border-b-0"
                >
                  <span className="grid size-10 place-items-center rounded-xl bg-primary-soft text-primary-fg">
                    <Icon name={icon} className="size-5" />
                  </span>
                  <h3 className="text-lg font-semibold">
                    {t(`site.feature${index + 1}.title`)}
                  </h3>
                  <p className="text-sm leading-relaxed text-muted">
                    {t(`site.feature${index + 1}.body`)}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section
            aria-labelledby="site-results"
            className="flex flex-col gap-7 border-y border-line py-10 sm:py-12"
          >
            <div className="flex flex-col gap-2">
              <h2
                id="site-results"
                className="text-2xl font-semibold tracking-tight sm:text-3xl"
              >
                {t('site.results.title')}
              </h2>
              <p className="text-sm text-muted">{t('site.results.subtitle')}</p>
            </div>
            <ul
              data-testid="site-results"
              className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4"
            >
              {results.map((n) => (
                <li
                  key={n}
                  className="flex min-w-0 flex-col gap-2 border-l border-line pl-4"
                >
                  <p className="text-4xl font-semibold tracking-tight text-brand">
                    {t(`site.result${n}.value`)}
                  </p>
                  <h3 className="font-semibold">
                    {t(`site.result${n}.title`)}
                  </h3>
                  <p className="text-sm text-muted">
                    {t(`site.result${n}.body`)}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          {SITE_CLIENTS.length > 0 ? (
            <section
              aria-labelledby="site-clients"
              data-testid="site-clients"
              className="flex flex-col gap-5"
            >
              <h2
                id="site-clients"
                className="text-2xl font-semibold tracking-tight sm:text-3xl"
              >
                {t('site.clients.title')}
              </h2>
              <div className="overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_10%,#000_90%,transparent)]">
                <ul className="site-marquee flex w-max items-center gap-10 py-2">
                  {[...SITE_CLIENTS, ...SITE_CLIENTS].map((client, i) => (
                    <li
                      key={`${client.name}-${i}`}
                      aria-hidden={i >= SITE_CLIENTS.length || undefined}
                      className="flex h-14 shrink-0 items-center"
                    >
                      <img
                        src={client.logo}
                        alt={client.name}
                        loading="lazy"
                        className="max-h-12 w-auto opacity-80 grayscale transition hover:opacity-100 hover:grayscale-0"
                      />
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}

          <section aria-labelledby="site-steps" className="flex flex-col gap-7">
            <h2 id="site-steps" className={HEADING}>
              {t('site.steps.title')}
            </h2>
            <ol className="grid grid-cols-1 gap-5 md:grid-cols-3">
              {steps.map((n) => (
                <li
                  key={n}
                  className="flex min-w-0 flex-col gap-3 border-t border-line pt-5"
                >
                  <span
                    aria-hidden="true"
                    className="font-mono text-sm font-semibold text-brand"
                  >
                    {String(n).padStart(2, '0')}
                  </span>
                  <h3 className="text-xl font-semibold tracking-tight">
                    {t(`site.step${n}.title`)}
                  </h3>
                  <p className="text-sm leading-relaxed text-muted">
                    {t(`site.step${n}.body`)}
                  </p>
                </li>
              ))}
            </ol>
          </section>

          <section
            id="pricing"
            aria-labelledby="site-plans"
            className="flex scroll-mt-6 flex-col gap-6 rounded-[2rem] bg-canvas p-4 sm:p-8 lg:p-10"
          >
            <div className="flex flex-col gap-3">
              <h2 id="site-plans" className={HEADING}>
                {t('site.plans.title')}
              </h2>
              <p className="text-base text-muted">{t('site.plans.subtitle')}</p>
            </div>
            {plans.isPending ? (
              <p role="status" className="text-sm text-muted">
                {t('site.plans.loading')}
              </p>
            ) : null}
            <ul
              data-testid="site-plans"
              className={`grid gap-4 ${visiblePlans.length > 1 ? 'md:grid-cols-2' : ''} ${visiblePlans.length > 2 ? 'lg:grid-cols-3' : ''}`}
            >
              {visiblePlans.map((plan) => {
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
                    className={`${CARD} bg-surface`}
                  >
                    <h3 className="text-lg font-semibold [overflow-wrap:anywhere]">
                      {plan.name}
                    </h3>
                    <p className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-3xl">
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
              <li
                data-testid="site-enterprise"
                className={`${CARD} col-span-full bg-primary-soft sm:flex-row sm:items-center sm:justify-between sm:gap-6`}
              >
                <div className="flex min-w-0 flex-col gap-2">
                  <h3 className="text-sm font-semibold text-primary-fg">
                    {t('site.enterprise.name')}
                  </h3>
                  <p className="text-2xl font-semibold tracking-tight">
                    {t('site.enterprise.price')}
                  </p>
                  <p className="text-sm text-muted">
                    {t('site.enterprise.body')}
                  </p>
                </div>
                <a
                  href="#contact"
                  data-testid="site-enterprise-contact"
                  className={`${CTA_SECONDARY} shrink-0`}
                >
                  {t('site.enterprise.contact')}
                </a>
              </li>
            </ul>
            {visiblePlans.length < list.length ? (
              <Button
                data-testid="site-plans-more"
                className="self-center"
                onClick={() => setVisiblePlanCount((count) => count + 6)}
              >
                {t('list.loadMore')}
              </Button>
            ) : null}
            {list.length === 0 && !plans.isPending ? (
              <div>
                <Link href={signupHref()} className={CTA}>
                  {t('site.cta')}
                </Link>
              </div>
            ) : null}
          </section>

          <section
            id="faq"
            aria-labelledby="site-faq"
            className="grid scroll-mt-6 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-14"
          >
            <h2 id="site-faq" className={HEADING}>
              {t('site.faq.title')}
            </h2>
            <div className="divide-y divide-line border-y border-line">
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <details key={n} className="group">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-sm py-4 font-semibold [&::-webkit-details-marker]:hidden">
                    {t(`site.faq${n}.q`)}
                    <Icon
                      name="plus"
                      className="size-5 shrink-0 text-brand group-open:rotate-45"
                    />
                  </summary>
                  <p className="pb-5 pr-8 text-sm leading-relaxed text-muted">
                    {t(`site.faq${n}.a`)}
                  </p>
                </details>
              ))}
            </div>
          </section>

          <section
            id="contact"
            aria-labelledby="site-contact-title"
            className="grid scroll-mt-6 items-center gap-7 rounded-[2rem] bg-[#0b142b] px-5 py-8 text-white sm:p-10 lg:grid-cols-2 lg:gap-12 lg:p-14"
          >
            <div className="flex flex-col gap-4">
              <h2 id="site-contact-title" className={`${HEADING} text-balance`}>
                {t('site.contact.title')}
              </h2>
              <p className="max-w-md text-base leading-relaxed text-slate-200">
                {t('site.contact.body')}
              </p>
            </div>
            {plans.data?.inquiryForm ? (
              <div className="min-w-0 rounded-2xl bg-surface p-4 text-fg sm:p-6">
                <SiteContactForm telegramUrl={contact} />
              </div>
            ) : (
              // Owner 2026-11-24: until the form reaches a Telegram chat, people
              // write to the sales account themselves.
              <div className="flex flex-col items-start justify-center gap-3">
                {contact ? (
                  <a
                    href={contact}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="site-contact"
                    className={`${CTA} gap-2 text-lg`}
                  >
                    <Icon name="send" className="h-5 w-5" />
                    {t('site.contact.telegramCta')}
                  </a>
                ) : null}
                <Link href={signupHref()} className={CTA_SECONDARY}>
                  {t('site.cta')}
                </Link>
              </div>
            )}
          </section>
        </div>
      </main>
      <footer className="border-t border-line bg-canvas">
        <div
          className={`${CONTAINER} flex flex-wrap items-center justify-between gap-x-7 gap-y-3 py-6`}
        >
          <BrandLogo name={t('app.brand')} />
          <LegalLinks />
          <Link
            href="/login"
            className="flex min-h-11 items-center text-sm font-semibold underline underline-offset-4"
          >
            {t('site.footer.signIn')}
          </Link>
        </div>
      </footer>
    </div>
  );
}
