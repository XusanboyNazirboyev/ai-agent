'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import {
  EMPTY_GUIDE_LOCAL,
  currentStep,
  guideSteps,
  guideVisible,
  parseGuideLocal,
  type GuideKey,
  type GuideLocal,
} from '@/lib/setup-guide';
import type { AssistantLight, TodaySummary } from '@/lib/today';
import { Button, buttonClass } from './ui/button';

const STORAGE_KEY = 'ac_setup_guide';

function readLocal(): GuideLocal {
  try {
    return parseGuideLocal(localStorage.getItem(STORAGE_KEY));
  } catch {
    return EMPTY_GUIDE_LOCAL;
  }
}

function writeLocal(value: GuideLocal): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* storage blocked: the choice lasts for this page view */
  }
}

/**
 * Guided setup for a new owner (ADR 080): one step per card, plain words.
 * Done states are the server's (`GET /api/v1/today`); only "skipped" and the
 * "templates opened" mark live on this device.
 */
export function SetupGuide(props: {
  checklist: NonNullable<TodaySummary['checklist']>;
  light: AssistantLight;
  welcome: boolean;
}): ReactNode {
  const { t } = useI18n();
  const [local, setLocal] = useState<GuideLocal>(EMPTY_GUIDE_LOCAL);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setLocal(readLocal());
    setReady(true);
  }, []);
  const steps = guideSteps(props.checklist, props.light, local);
  const step = currentStep(steps);
  if (
    !ready ||
    !guideVisible({
      welcome: props.welcome,
      selfSignup: props.checklist.selfSignup === true,
      steps,
      local,
    })
  )
    return null;

  function update(next: GuideLocal): void {
    setLocal(next);
    writeLocal(next);
  }
  function skip(key: GuideKey): void {
    update({ ...local, skipped: [...new Set([...local.skipped, key])] });
  }
  const done = steps.filter((s) => s.done).length;

  return (
    <section
      data-testid="setup-guide"
      aria-label={t('signup.guide.title')}
      className="flex flex-col gap-3 rounded-2xl border border-primary bg-surface p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{t('signup.guide.title')}</h3>
        <span className="text-sm text-muted" data-testid="setup-guide-progress">
          {t('signup.guide.progress', { done, total: steps.length })}
        </span>
      </div>
      {step ? (
        <div
          data-testid={`setup-guide-${step.key}`}
          className="flex flex-col gap-3"
        >
          <p className="text-lg font-medium">
            {t(`signup.guide.${step.key}.title`)}
          </p>
          <p className="text-sm text-muted">
            {t(`signup.guide.${step.key}.body`)}
          </p>
          {step.key === 'channel' ? (
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
              <li>{t('signup.guide.channel.s1')}</li>
              <li>{t('signup.guide.channel.s2')}</li>
              <li>{t('signup.guide.channel.s3')}</li>
            </ol>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Link
              href={step.href}
              data-testid="setup-guide-do"
              onClick={() =>
                step.key === 'business'
                  ? update({ ...local, businessDone: true })
                  : undefined
              }
              className={buttonClass('primary', 'md')}
            >
              {t('today.setup.go')}
            </Link>
            <Button
              variant="secondary"
              data-testid="setup-guide-skip"
              onClick={() => skip(step.key)}
            >
              {t('signup.guide.skip')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">{t('signup.guide.later')}</p>
          <Button
            variant="secondary"
            data-testid="setup-guide-reset"
            onClick={() => update({ ...local, skipped: [] })}
          >
            {t('signup.guide.showSkipped')}
          </Button>
        </div>
      )}
    </section>
  );
}
