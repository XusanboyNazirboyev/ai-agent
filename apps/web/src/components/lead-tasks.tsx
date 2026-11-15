'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { useShell } from './app-shell';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';

export interface LeadTask {
  id: string;
  leadId: string;
  title: string;
  dueAt: string;
  assignee: { id: string; displayName: string } | null;
  doneAt: string | null;
  overdue: boolean;
  contactName?: string | null;
}

/** "YYYY-MM-DDTHH:mm" for a datetime-local field, `hours` from now. */
function localInput(hours: number): string {
  const at = new Date(Date.now() + hours * 3_600_000);
  at.setMinutes(0, 0, 0);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:00`;
}

export function invalidateTasks(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: ['lead-tasks'] });
  void qc.invalidateQueries({ queryKey: ['tasks-mine'] });
  void qc.invalidateQueries({ queryKey: ['lead-timeline'] });
}

/** One task row: finish it with the checkbox, see when and for whom. */
export function TaskRow(props: {
  task: LeadTask;
  canEdit: boolean;
  showContact?: boolean;
}): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { timeZone } = useShell();
  const qc = useQueryClient();
  const { task } = props;
  const toggle = useMutation({
    mutationFn: () =>
      api(`/api/v1/tasks/${task.id}`, {
        method: 'PATCH',
        body: { done: task.doneAt === null },
      }),
    onSettled: () => invalidateTasks(qc),
  });
  return (
    <li
      data-testid="task"
      data-done={task.doneAt !== null}
      className="flex items-start gap-2 text-sm"
    >
      <input
        type="checkbox"
        aria-label={t('tasks.done', { title: task.title })}
        checked={task.doneAt !== null}
        disabled={!props.canEdit || toggle.isPending}
        onChange={() => toggle.mutate()}
        className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={`break-words ${task.doneAt ? 'text-muted line-through' : 'font-medium'}`}
        >
          {task.title}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {props.showContact && task.contactName ? (
            <span>{task.contactName} ·</span>
          ) : null}
          <span>{formatDateTime(task.dueAt, timeZone)}</span>
          {task.assignee ? <span>· {task.assignee.displayName}</span> : null}
          {task.overdue ? (
            <Badge tone="danger">{t('tasks.overdue')}</Badge>
          ) : null}
        </span>
      </span>
    </li>
  );
}

/** Tasks on a lead (P1.6, ADR 068), in the lead panel. */
export function LeadTasks(props: { leadId: string }): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const qc = useQueryClient();
  const canEdit = operator.role !== 'VIEWER';
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(() => localInput(24));
  const list = useQuery({
    queryKey: ['lead-tasks', props.leadId],
    queryFn: () =>
      api<{ items: LeadTask[] }>(`/api/v1/leads/${props.leadId}/tasks`),
  });
  const add = useMutation({
    mutationFn: () =>
      api<LeadTask>(`/api/v1/leads/${props.leadId}/tasks`, {
        method: 'POST',
        body: { title: title.trim(), dueAt: new Date(due).toISOString() },
      }),
    onSuccess: () => {
      setTitle('');
      invalidateTasks(qc);
    },
  });
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (title.trim() && due && !add.isPending) add.mutate();
  }
  const items = list.data?.items ?? [];
  return (
    <section
      data-testid="lead-tasks"
      aria-labelledby="lead-tasks-title"
      className="flex flex-col gap-2"
    >
      <h3
        id="lead-tasks-title"
        className="text-xs font-semibold uppercase tracking-wide text-muted"
      >
        {t('tasks.title')}
      </h3>
      {items.length === 0 && list.isSuccess ? (
        <p className="text-sm text-muted">{t('tasks.none')}</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {items.map((task) => (
          <TaskRow key={task.id} task={task} canEdit={canEdit} />
        ))}
      </ul>
      {canEdit ? (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <input
            aria-label={t('tasks.newTitle')}
            placeholder={t('tasks.newTitle')}
            data-testid="task-title"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            className={`${fieldClass} min-w-0 flex-1 basis-40`}
          />
          <input
            type="datetime-local"
            aria-label={t('tasks.due')}
            data-testid="task-due"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className={`${fieldClass} w-auto min-w-0`}
          />
          <Button
            type="submit"
            icon="plus"
            data-testid="task-add"
            loading={add.isPending}
            disabled={!title.trim()}
          >
            {t('tasks.add')}
          </Button>
          {add.isError ? (
            <p role="alert" className="basis-full text-sm text-danger-fg">
              {t(errorKey(add.error))}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}

/** "My tasks" on the Today page: open tasks due by the end of today. */
export function MyTasksCard(): ReactNode {
  const { t } = useI18n();
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const until = end.toISOString().slice(0, 13);
  const mine = useQuery({
    queryKey: ['tasks-mine', until],
    queryFn: () =>
      api<{ items: LeadTask[] }>(
        `/api/v1/tasks/mine?until=${encodeURIComponent(end.toISOString())}`,
      ),
  });
  const items = mine.data?.items ?? [];
  if (!mine.isSuccess || items.length === 0) return null;
  return (
    <section
      data-testid="today-tasks"
      aria-labelledby="today-tasks-title"
      className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4"
    >
      <h3 id="today-tasks-title" className="font-semibold">
        {t('tasks.today', { count: items.length })}
      </h3>
      <ul className="flex flex-col gap-2">
        {items.map((task) => (
          <TaskRow key={task.id} task={task} canEdit showContact />
        ))}
      </ul>
    </section>
  );
}
