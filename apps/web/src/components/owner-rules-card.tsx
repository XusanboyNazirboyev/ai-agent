'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { useToast } from './ui/toast';

export const MAX_RULES = 10;
export const MAX_RULE_LENGTH = 300;

/** One rule per line; empty lines dropped, at most ten (as the API allows). */
export function rulesFromText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .slice(0, MAX_RULES);
}

/**
 * Owner 2026-11-24: the business owner writes the AI agent's own rules
 * ("if a discount is asked, hand over"). They never outrank the built-in
 * rules: prices, discounts and claims stay with the code.
 */
export function OwnerRulesCard({
  canChange,
}: {
  canChange: boolean;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['agent-rules'],
    queryFn: () => api<{ rules: string[] }>('/api/v1/business-profile/rules'),
  });
  const [text, setText] = useState('');
  useEffect(() => {
    if (query.data) setText(query.data.rules.join('\n'));
  }, [query.data]);
  const save = useMutation({
    mutationFn: (rules: string[]) =>
      api<{ rules: string[] }>('/api/v1/business-profile/rules', {
        method: 'PUT',
        body: { rules },
      }),
    onSuccess: (saved) => {
      toast(t('agent.ownerRules.saved'));
      queryClient.setQueryData(['agent-rules'], saved);
    },
  });
  const rules = rulesFromText(text);
  const tooLong = rules.some((rule) => rule.length > MAX_RULE_LENGTH);
  const tooMany =
    text.split('\n').filter((line) => line.trim()).length > MAX_RULES;
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!tooLong && !tooMany) save.mutate(rules);
  }
  return (
    <section
      data-testid="owner-rules"
      className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold">{t('agent.ownerRules.title')}</h2>
        <p className="text-sm text-muted">{t('agent.ownerRules.intro')}</p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('agent.ownerRules.label', { max: MAX_RULES })}
          <textarea
            rows={6}
            value={text}
            disabled={!canChange || query.isLoading}
            placeholder={t('agent.ownerRules.placeholder')}
            data-testid="owner-rules-text"
            className={`${fieldClass} min-h-32 py-2`}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {tooMany || tooLong ? (
          <p role="alert" className="text-sm text-danger-fg">
            {tooMany
              ? t('agent.ownerRules.tooMany', { max: MAX_RULES })
              : t('agent.ownerRules.tooLong', { max: MAX_RULE_LENGTH })}
          </p>
        ) : null}
        {save.isError ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t(errorKey(save.error))}
          </p>
        ) : null}
        {canChange ? (
          <Button
            type="submit"
            variant="primary"
            loading={save.isPending}
            disabled={tooMany || tooLong}
            data-testid="owner-rules-save"
            className="self-start"
          >
            {t('profile.save')}
          </Button>
        ) : null}
      </form>
    </section>
  );
}
