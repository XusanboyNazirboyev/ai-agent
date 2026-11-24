'use client';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { canManageTeam } from '@/lib/roles';
import { useShell } from './app-shell';
import { BotScheduleCard } from './bot-schedule-card';
import { BusinessProfileCard } from './business-profile-card';
import { OwnerRulesCard } from './owner-rules-card';
import { Icon } from './ui/icons';

/** The built-in rules the agent always follows (code enforces them, ADR 086/087). */
const RULES = [
  'bot.rule1',
  'bot.rule2',
  'bot.rule3',
  'agent.rules.noGuess',
  'agent.rules.noClaim',
];

/**
 * Owner 2026-11-23: what the AI agent may say about the business (the
 * business profile) and the rules it always follows.
 */
export function AgentRulesPage(): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('agent.tab.rules')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 sm:p-6">
        <p className="text-sm text-muted">{t('agent.rules.intro')}</p>
        <BusinessProfileCard canChange={canManageTeam(operator.role)} />
        <OwnerRulesCard canChange={canManageTeam(operator.role)} />
        <BotScheduleCard canChange={canManageTeam(operator.role)} />
        <section
          data-testid="agent-rules"
          className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 sm:p-5"
        >
          <h2 className="font-semibold">{t('bot.rulesTitle')}</h2>
          <ul className="flex flex-col gap-2 text-sm text-muted">
            {RULES.map((key) => (
              <li key={key} className="flex items-start gap-2">
                <Icon
                  name="check"
                  className="mt-0.5 h-4 w-4 shrink-0 text-success-fg"
                />
                {t(key)}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
