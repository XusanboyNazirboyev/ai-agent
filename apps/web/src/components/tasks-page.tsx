'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { LeadPipelinePage } from '@/lib/types';
import { useShell } from './app-shell';
import {
  invalidateTasks,
  RemindSelect,
  remindValue,
  toLocalInput,
  type LeadTask,
} from './lead-tasks';
import { NotificationControl } from './notification-control';
import { Avatar } from './ui/avatar';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { fieldClass } from './ui/fields';
import { FormDialog } from './ui/form-dialog';
import { Select } from './ui/select';
import { SkeletonRows } from './ui/skeleton';

const STATUSES = ['overdue', 'today', 'upcoming', 'done'] as const;
type Status = (typeof STATUSES)[number];
type Scope = 'mine' | 'all';

interface TaskRowData extends LeadTask {
  contactName: string | null;
}
interface TaskPage {
  items: TaskRowData[];
  nextCursor: string | null;
  counts: Record<Status, number>;
}
interface Member {
  id: string;
  displayName: string;
  isActive: boolean;
}

function useTeam(): Member[] {
  const team = useQuery({
    queryKey: ['team'],
    queryFn: () => api<{ operators: Member[] }>('/api/v1/team'),
  });
  return (team.data?.operators ?? []).filter((m) => m.isActive);
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/** Search leads as you type (name, or three or more phone digits). */
function LeadPicker(props: {
  value: { id: string; name: string } | null;
  onChange: (lead: { id: string; name: string } | null) => void;
}): ReactNode {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 300);
  const found = useQuery({
    queryKey: ['tasks-lead-search', q],
    enabled: q.length > 0 && props.value === null,
    queryFn: () =>
      api<LeadPipelinePage>(
        `/api/v1/leads?${new URLSearchParams({ q, limit: '8' }).toString()}`,
      ),
  });
  if (props.value)
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm">
        <span
          data-testid="task-lead-selected"
          className="min-w-0 break-words font-medium"
        >
          {props.value.name}
        </span>
        <Button size="sm" variant="ghost" onClick={() => props.onChange(null)}>
          {t('tasks.leadChange')}
        </Button>
      </div>
    );
  const items = found.data?.items ?? [];
  return (
    <div className="flex flex-col gap-1">
      <input
        aria-label={t('tasks.lead')}
        placeholder={t('tasks.leadSearch')}
        data-testid="task-lead-search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className={fieldClass}
      />
      {found.isSuccess && q && items.length === 0 ? (
        <p className="text-sm text-muted">{t('tasks.leadNone')}</p>
      ) : null}
      <ul className="flex flex-col">
        {items.map((lead) => {
          const name = lead.contact.name ?? lead.contact.phone ?? '-';
          return (
            <li key={lead.id}>
              <button
                type="button"
                data-testid="task-lead-option"
                onClick={() => props.onChange({ id: lead.id, name })}
                className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 text-left text-sm hover:bg-surface-2"
              >
                <span className="min-w-0 break-words">{name}</span>
                {lead.contact.phone && lead.contact.name ? (
                  <span className="text-xs text-muted">
                    {lead.contact.phone}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Create (lead picker) or edit (title, due, assignee, reminder) one task. */
function TaskDialog(props: {
  task: TaskRowData | null;
  onClose: () => void;
}): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const qc = useQueryClient();
  const team = useTeam();
  const editing = props.task;
  const [title, setTitle] = useState(editing?.title ?? '');
  const [due, setDue] = useState(() => {
    if (editing) return toLocalInput(editing.dueAt);
    const at = new Date(Date.now() + 24 * 3_600_000);
    at.setMinutes(0, 0, 0);
    return toLocalInput(at.toISOString());
  });
  const [assignee, setAssignee] = useState(
    editing ? (editing.assignee?.id ?? '') : operator.id,
  );
  const [remind, setRemind] = useState(editing ? remindValue(editing) : '0');
  const [lead, setLead] = useState<{ id: string; name: string } | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: title.trim(),
        dueAt: new Date(due).toISOString(),
        assigneeId: assignee || null,
        remindBefore: Number(remind),
      };
      return editing
        ? api(`/api/v1/tasks/${editing.id}`, { method: 'PATCH', body })
        : api(`/api/v1/leads/${lead!.id}/tasks`, { method: 'POST', body });
    },
    onSuccess: () => {
      invalidateTasks(qc);
      props.onClose();
    },
  });
  const ready = title.trim() !== '' && due !== '' && (editing || lead !== null);
  return (
    <FormDialog
      open
      testId="task-dialog"
      title={editing ? t('tasks.edit') : t('tasks.new')}
      onClose={props.onClose}
      onSubmit={() => ready && !save.isPending && save.mutate()}
      footer={
        <>
          <Button onClick={props.onClose}>{t('tasks.cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            data-testid="task-save"
            loading={save.isPending}
            disabled={!ready}
          >
            {t('tasks.save')}
          </Button>
        </>
      }
    >
      {editing ? null : <LeadPicker value={lead} onChange={setLead} />}
      <input
        aria-label={t('tasks.newTitle')}
        placeholder={t('tasks.newTitle')}
        data-testid="task-form-title"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        className={fieldClass}
      />
      <input
        type="datetime-local"
        aria-label={t('tasks.due')}
        data-testid="task-form-due"
        value={due}
        onChange={(e) => setDue(e.target.value)}
        className={fieldClass}
      />
      <Select
        field
        icon="user"
        aria-label={t('tasks.assignee')}
        data-testid="task-form-assignee"
        value={assignee}
        onChange={(e) => setAssignee(e.target.value)}
      >
        <option value="">{t('tasks.unassigned')}</option>
        {team.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName}
          </option>
        ))}
      </Select>
      <RemindSelect
        value={remind}
        onChange={setRemind}
        testId="task-form-remind"
      />
      {save.isError ? (
        <p role="alert" className="text-sm text-danger-fg">
          {t(errorKey(save.error))}
        </p>
      ) : null}
    </FormDialog>
  );
}

function Row(props: {
  task: TaskRowData;
  canEdit: boolean;
  onEdit: (task: TaskRowData) => void;
  onDelete: (task: TaskRowData) => void;
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
      data-testid="task-row"
      className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3 text-sm"
    >
      <input
        type="checkbox"
        aria-label={t('tasks.done', { title: task.title })}
        checked={task.doneAt !== null}
        disabled={!props.canEdit || toggle.isPending}
        onChange={() => toggle.mutate()}
        className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className={`break-words ${task.doneAt ? 'text-muted line-through' : 'font-medium'}`}
        >
          {task.title}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className={task.overdue ? 'font-medium text-danger-fg' : ''}>
            {formatDateTime(task.dueAt, timeZone)}
          </span>
          {task.overdue ? (
            <Badge tone="danger">{t('tasks.overdue')}</Badge>
          ) : null}
          <Link
            href={`/leads/${task.leadId}`}
            className="break-words text-primary-fg underline"
          >
            {task.contactName ?? t('tasks.lead')}
          </Link>
          {task.assignee ? (
            <span className="flex items-center gap-1">
              <Avatar name={task.assignee.displayName} size="xs" />
              {task.assignee.displayName}
            </span>
          ) : (
            <span>{t('tasks.unassigned')}</span>
          )}
        </span>
      </div>
      {props.canEdit ? (
        <span className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="ghost"
            icon="pencil"
            aria-label={t('tasks.editTask', { title: task.title })}
            onClick={() => props.onEdit(task)}
          />
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            aria-label={t('tasks.deleteTask', { title: task.title })}
            onClick={() => props.onDelete(task)}
          />
        </span>
      ) : null}
    </li>
  );
}

/** The Tasks page (ADR 068 amendment): segments, scope, create, edit, delete. */
export function TasksPage(): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const qc = useQueryClient();
  const canEdit = operator.role !== 'VIEWER';
  const canFilterPeople =
    operator.role === 'OWNER' || operator.role === 'ADMIN';
  const [status, setStatus] = useState<Status>('today');
  const [scope, setScope] = useState<Scope>('mine');
  const [assignee, setAssignee] = useState('');
  const [dialog, setDialog] = useState<{ task: TaskRowData | null } | null>(
    null,
  );
  const [removing, setRemoving] = useState<TaskRowData | null>(null);
  const team = useTeam();
  const list = useInfiniteQuery({
    queryKey: ['tasks-page', scope, status, scope === 'all' ? assignee : ''],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ scope, status, limit: '30' });
      if (scope === 'all' && assignee) params.set('assigneeId', assignee);
      if (pageParam) params.set('cursor', pageParam);
      return api<TaskPage>(`/api/v1/tasks?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const remove = useMutation({
    mutationFn: (task: TaskRowData) =>
      api(`/api/v1/tasks/${task.id}`, { method: 'DELETE' }),
    onSettled: () => {
      setRemoving(null);
      invalidateTasks(qc);
    },
  });
  const counts = list.data?.pages[0]?.counts;
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 sm:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-xl font-semibold">{t('tasks.page.title')}</h1>
            <NotificationControl />
          </div>
          {canEdit ? (
            <Button
              variant="primary"
              icon="plus"
              data-testid="task-new"
              onClick={() => setDialog({ task: null })}
            >
              {t('tasks.new')}
            </Button>
          ) : null}
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={t('tasks.scope.label')}
            className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1"
          >
            {(['mine', 'all'] as const).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={scope === id}
                data-testid={`tasks-scope-${id}`}
                onClick={() => setScope(id)}
                className={`min-h-9 rounded-lg px-3 text-sm font-medium ${scope === id ? 'bg-surface shadow-sm' : 'text-muted'}`}
              >
                {t(`tasks.scope.${id}`)}
              </button>
            ))}
          </div>
          {canFilterPeople && scope === 'all' ? (
            <Select
              compact
              icon="user"
              aria-label={t('tasks.assignee')}
              data-testid="tasks-assignee-filter"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
            >
              <option value="">{t('tasks.assignee.all')}</option>
              {team.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </Select>
          ) : null}
        </div>

        <div
          role="group"
          aria-label={t('tasks.segment.label')}
          className="flex gap-1 overflow-x-auto rounded-xl bg-surface-2 p-1"
        >
          {STATUSES.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={status === id}
              data-testid={`tasks-segment-${id}`}
              onClick={() => setStatus(id)}
              className={`flex min-h-9 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium ${status === id ? 'bg-surface shadow-sm' : 'text-muted'}`}
            >
              {t(`tasks.seg.${id}`)}
              {counts ? (
                <span
                  data-testid={`tasks-count-${id}`}
                  className={`text-xs ${id === 'overdue' && counts[id] > 0 ? 'font-semibold text-danger-fg' : 'text-muted'}`}
                >
                  {counts[id]}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {list.isPending ? <SkeletonRows /> : null}
        {list.isError ? (
          <div role="alert" className="flex flex-col items-start gap-2 text-sm">
            <p className="text-danger-fg">{t(errorKey(list.error))}</p>
            <Button size="sm" onClick={() => void list.refetch()}>
              {t('tasks.retry')}
            </Button>
          </div>
        ) : null}
        {list.isSuccess && items.length === 0 ? (
          <p
            data-testid="tasks-empty"
            className="py-8 text-center text-sm text-muted"
          >
            {t(`tasks.empty.${status}`)}
          </p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {items.map((task) => (
            <Row
              key={task.id}
              task={task}
              canEdit={canEdit}
              onEdit={(row) => setDialog({ task: row })}
              onDelete={setRemoving}
            />
          ))}
        </ul>
        {list.hasNextPage ? (
          <Button
            loading={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {t('tasks.loadMore')}
          </Button>
        ) : null}
      </div>
      {dialog ? (
        <TaskDialog task={dialog.task} onClose={() => setDialog(null)} />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={t('tasks.delete')}
        body={t('tasks.deleteBody', { title: removing?.title ?? '' })}
        confirmLabel={t('tasks.delete')}
        cancelLabel={t('tasks.cancel')}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
