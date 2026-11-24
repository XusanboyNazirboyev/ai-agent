'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { Select } from './ui/select';
import { useToast } from './ui/toast';

export type BotSchedule = {
  mode: 'always' | 'off_hours' | 'work_hours';
  /** ISO weekdays, 1 Monday … 7 Sunday. */
  days: number[];
  from: string;
  to: string;
};

const MODES: BotSchedule['mode'][] = ['always', 'off_hours', 'work_hours'];
const WEEK = [1, 2, 3, 4, 5, 6, 7];

/** What the API refuses: no working day, or a window that starts where it ends. */
export function scheduleProblem(s: BotSchedule): string | null {
  if (s.mode === 'always') return null;
  if (s.days.length === 0) return 'agent.schedule.noDays';
  if (s.from === s.to) return 'agent.schedule.sameTime';
  return null;
}

/** ADR 089: when the AI agent answers customers. */
export function BotScheduleCard({
  canChange,
}: {
  canChange: boolean;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['bot-schedule'],
    queryFn: () => api<BotSchedule>('/api/v1/business-profile/schedule'),
  });
  const [draft, setDraft] = useState<BotSchedule | null>(null);
  useEffect(() => {
    if (query.data) setDraft(query.data);
  }, [query.data]);
  const save = useMutation({
    mutationFn: (body: BotSchedule) =>
      api<BotSchedule>('/api/v1/business-profile/schedule', {
        method: 'PUT',
        body,
      }),
    onSuccess: (saved) => {
      toast(t('agent.schedule.saved'));
      queryClient.setQueryData(['bot-schedule'], saved);
    },
  });
  if (!draft) return null;
  const problem = scheduleProblem(draft);
  const disabled = !canChange || save.isPending;
  const set = (patch: Partial<BotSchedule>): void =>
    setDraft({ ...draft, ...patch });
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (draft && !problem) save.mutate(draft);
  }
  return (
    <section
      data-testid="bot-schedule"
      className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold">{t('agent.schedule.title')}</h2>
        <p className="text-sm text-muted">{t('agent.schedule.intro')}</p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('agent.schedule.mode')}
          <Select
            field
            value={draft.mode}
            disabled={disabled}
            data-testid="bot-schedule-mode"
            onChange={(e) =>
              set({ mode: e.target.value as BotSchedule['mode'] })
            }
          >
            {MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`agent.schedule.mode.${mode}`)}
              </option>
            ))}
          </Select>
        </label>
        {draft.mode !== 'always' ? (
          <>
            <fieldset className="flex flex-col gap-1.5 text-sm font-medium">
              <legend className="mb-1.5">{t('agent.schedule.days')}</legend>
              <div className="flex flex-wrap gap-1.5">
                {WEEK.map((day) => {
                  const on = draft.days.includes(day);
                  return (
                    <Button
                      key={day}
                      type="button"
                      size="sm"
                      variant={on ? 'primary' : 'ghost'}
                      aria-pressed={on}
                      disabled={disabled}
                      data-testid={`bot-schedule-day-${day}`}
                      onClick={() =>
                        set({
                          days: on
                            ? draft.days.filter((d) => d !== day)
                            : [...draft.days, day].sort((a, b) => a - b),
                        })
                      }
                    >
                      {t(`agent.schedule.day.${day}`)}
                    </Button>
                  );
                })}
              </div>
            </fieldset>
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {t('agent.schedule.from')}
                <input
                  type="time"
                  required
                  value={draft.from}
                  disabled={disabled}
                  data-testid="bot-schedule-from"
                  className={fieldClass}
                  onChange={(e) => set({ from: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {t('agent.schedule.to')}
                <input
                  type="time"
                  required
                  value={draft.to}
                  disabled={disabled}
                  data-testid="bot-schedule-to"
                  className={fieldClass}
                  onChange={(e) => set({ to: e.target.value })}
                />
              </label>
            </div>
            <p className="text-sm text-muted">
              {t(`agent.schedule.explain.${draft.mode}`)}
            </p>
          </>
        ) : null}
        {problem ? (
          <p role="alert" className="text-sm text-danger-fg">
            {t(problem)}
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
            disabled={problem !== null}
            data-testid="bot-schedule-save"
            className="self-start"
          >
            {t('profile.save')}
          </Button>
        ) : null}
      </form>
    </section>
  );
}
