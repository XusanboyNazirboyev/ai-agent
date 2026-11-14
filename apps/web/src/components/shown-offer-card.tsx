'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { describeShownOffer, groupAmount } from '@/lib/shown-offer';
import { Badge, type Tone } from './ui/badge';
import { Icon } from './ui/icons';

const AVAILABILITY_TONE: Record<string, Tone> = {
  AVAILABLE: 'success',
  LIMITED: 'warning',
  SOLD_OUT: 'danger',
  UNKNOWN: 'neutral',
};

/**
 * What the customer was shown under an assistant reply: the offer's name, the
 * price, whether it is free and when it starts, as a small card an operator
 * reads at a glance. The internal ids sit in a closed "details" fold for
 * whoever needs to trace a fact.
 */
export function ShownOfferCard(props: {
  offerRef: string;
  facts: unknown;
  timeZone?: string;
}): ReactNode {
  const { t, formatDateTime } = useI18n();
  const view = describeShownOffer(props.offerRef, props.facts);
  const when = (iso: string): string => formatDateTime(iso, props.timeZone);
  return (
    <div
      data-testid="shown-offer"
      className="mt-1 flex flex-col gap-2 rounded-xl border border-line border-l-4 border-l-primary bg-surface p-3 text-sm text-fg"
    >
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
        <Icon name="tag" className="h-3.5 w-3.5" />
        {t('shownOffer.heading')}
      </p>
      <p className="font-semibold break-words" data-testid="shown-offer-title">
        {view.title ?? t('shownOffer.untitled')}
      </p>
      {view.price ? (
        <p
          className="flex flex-wrap items-baseline gap-x-2"
          data-testid="shown-offer-price"
        >
          <span className="text-xl font-semibold tabular-nums">
            {groupAmount(view.price.amount)} {view.price.currency}
          </span>
          {view.price.basis ? (
            <span className="text-muted">
              {t(`shownOffer.basis.${view.price.basis}`)}
            </span>
          ) : null}
          <Badge tone={view.price.confirmed ? 'success' : 'neutral'}>
            {view.price.confirmed
              ? t('shownOffer.confirmed')
              : t('shownOffer.listed')}
          </Badge>
        </p>
      ) : null}
      {view.availability || view.seats !== null || view.startsAt ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {view.availability ? (
            <Badge tone={AVAILABILITY_TONE[view.availability]} dot>
              {t(`shownOffer.avail.${view.availability}`)}
            </Badge>
          ) : null}
          {view.seats !== null ? (
            <Badge>{t('shownOffer.seats', { count: view.seats })}</Badge>
          ) : null}
          {view.startsAt ? (
            <Badge>
              <Icon name="clock" className="h-3 w-3" />
              {when(view.startsAt)}
            </Badge>
          ) : null}
        </div>
      ) : null}
      {view.checkedAt ? (
        <p className="text-xs text-muted">
          {t('shownOffer.checked', { time: when(view.checkedAt) })}
        </p>
      ) : null}
      <details className="text-xs text-muted">
        <summary className="cursor-pointer select-none">
          {t('shownOffer.details')}
        </summary>
        <p className="mt-1 break-all">{view.technical.join(' · ')}</p>
      </details>
    </div>
  );
}
