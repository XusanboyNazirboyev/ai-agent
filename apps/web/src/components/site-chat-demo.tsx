'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { BrandLogo } from './ui/brand';
import { Icon } from './ui/icons';

/** Who writes each line of the sample conversation, in order. */
const SCRIPT = ['c', 'b', 'c', 'b', 'c', 'b'] as const;
const INTRO_MESSAGES = 2;
const STEP_MS = 1_800;
const PAUSE_MS = 4_500;

/**
 * Owner 2026-11-24: until the demo video exists, the sales page opens with a
 * sample sale that types itself out and ends with the lead landing in the
 * CRM. Labelled a sample; no prices in it. Reduced motion shows it whole.
 */
export function SiteChatDemo(): ReactNode {
  const { t } = useI18n();
  const [shown, setShown] = useState(SCRIPT.length + 1);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let step = INTRO_MESSAGES - 1;
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      step = step > SCRIPT.length ? INTRO_MESSAGES : step + 1;
      setShown(step);
      timer = setTimeout(tick, step > SCRIPT.length ? PAUSE_MS : STEP_MS);
    };
    tick();
    return () => clearTimeout(timer);
  }, []);
  const typing = shown < SCRIPT.length ? SCRIPT[shown] : null;
  return (
    <figure
      data-testid="site-chat-demo"
      className="flex w-full flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-card"
    >
      <figcaption className="flex items-center justify-between gap-2 border-b border-line bg-surface-2 px-4 py-3 text-sm">
        {/* The logo keeps its width; on a narrow phone the badge wraps instead
            (the logo spilled at 320px with CI's fonts). */}
        <span className="flex shrink-0 items-center gap-2 font-semibold">
          <BrandLogo name={t('app.brand')} className="text-base" />
        </span>
        <span className="min-w-0 rounded-full bg-primary-soft px-2 py-0.5 text-center text-xs font-medium text-primary-fg">
          {t('site.demo.sample')}
        </span>
      </figcaption>
      <ol
        aria-label={t('site.demo.label')}
        className="flex min-h-80 flex-col justify-end gap-2 p-4 text-sm sm:min-h-96"
      >
        {SCRIPT.slice(0, shown).map((who, i) => (
          <li
            key={i}
            className={`max-w-[85%] rounded-2xl px-3 py-2 ${
              who === 'c'
                ? 'self-end rounded-br-sm bg-primary text-white'
                : 'self-start rounded-bl-sm bg-surface-2 text-fg'
            }`}
          >
            <span className="sr-only">
              {t(who === 'c' ? 'site.demo.customer' : 'site.demo.bot')}{' '}
            </span>
            {t(`site.demo.m${i + 1}`)}
          </li>
        ))}
        {typing ? (
          <li
            aria-hidden="true"
            className={`flex gap-1 rounded-2xl px-3 py-3 ${
              typing === 'c'
                ? 'self-end bg-primary/70'
                : 'self-start bg-surface-2'
            }`}
          >
            {[0, 1, 2].map((dot) => (
              <span
                key={dot}
                className="h-1.5 w-1.5 rounded-full bg-current opacity-60 motion-safe:animate-bounce"
                style={{ animationDelay: `${dot * 120}ms` }}
              />
            ))}
          </li>
        ) : null}
        {shown > SCRIPT.length ? (
          <li
            data-testid="site-demo-lead"
            className="flex items-center gap-2 self-center rounded-xl border border-line bg-success-soft px-3 py-2 text-xs font-medium text-success-fg"
          >
            <Icon name="check" className="h-4 w-4 shrink-0" />
            {t('site.demo.lead')}
          </li>
        ) : null}
      </ol>
    </figure>
  );
}
