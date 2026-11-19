'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import type { Tag } from '@/lib/types';
import { useShell } from './app-shell';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Select } from './ui/select';
import { FormDialog } from './ui/form-dialog';
import { Icon } from './ui/icons';
import { channelName } from '@/lib/channel-names';
import { NO_FILTERS, type LeadFilters } from './lead-board-utils';

const SOURCE_DEBOUNCE_MS = 300;

function useFilterOptions() {
  const { operator } = useShell();
  const manager = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const team = useQuery({
    queryKey: ['team'],
    queryFn: () =>
      api<{
        operators: { id: string; displayName: string; isActive: boolean }[];
      }>('/api/v1/team'),
    enabled: manager,
  });
  const tags = useQuery({
    queryKey: ['tags'],
    queryFn: () => api<{ items: Tag[] }>('/api/v1/tags'),
  });
  return {
    manager,
    operators: team.data?.operators ?? [],
    tags: tags.data?.items ?? [],
  };
}

/** The search box is not a filter: it has its own field in the toolbar. */
export function activeFilterCount(filters: LeadFilters): number {
  return Object.entries(filters).filter(([key, v]) => key !== 'q' && v).length;
}

/** Every filter cleared, the search text kept. */
export function clearedFilters(filters: LeadFilters): LeadFilters {
  return { ...NO_FILTERS, q: filters.q };
}

/** Channel types an operator can filter on (ADR 076). */
const FILTER_CHANNELS = ['telegram', 'instagram', 'facebook', 'manual'];
const SCORES = ['HOT', 'WARM', 'COLD'] as const;
const TASKS = ['none', 'overdue'] as const;
type Preset = 'today' | 'yesterday' | 'week' | 'month';
const PRESETS: Preset[] = ['today', 'yesterday', 'week', 'month'];

function localDate(offsetDays: number, now: Date = new Date()): string {
  const day = new Date(now);
  day.setDate(day.getDate() + offsetDays);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** Creation range of a quick preset, in the browser's calendar. */
export function presetRange(
  preset: Preset,
  now: Date = new Date(),
): { createdFrom: string; createdTo: string } {
  const today = localDate(0, now);
  switch (preset) {
    case 'today':
      return { createdFrom: today, createdTo: today };
    case 'yesterday': {
      const yesterday = localDate(-1, now);
      return { createdFrom: yesterday, createdTo: yesterday };
    }
    case 'week':
      return { createdFrom: localDate(-6, now), createdTo: today };
    case 'month':
      return { createdFrom: localDate(-29, now), createdTo: today };
  }
}

export function channelFilterLabel(
  channel: string,
  t: (key: string) => string,
): string {
  return channel === 'manual'
    ? t('leads.channel.manual')
    : channelName(channel);
}

function ChoiceChip(props: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      data-testid={props.testId}
      onClick={props.onClick}
      className={`inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium transition-colors ${
        props.selected
          ? 'border-primary bg-primary-soft text-primary-fg'
          : 'border-line bg-surface text-fg hover:bg-surface-2'
      }`}
    >
      {props.children}
    </button>
  );
}

function FilterGroup(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <div
      role="group"
      aria-label={props.label}
      className="flex min-w-0 flex-col gap-1.5"
    >
      <span className="text-xs font-semibold text-muted">{props.label}</span>
      <div className="flex min-w-0 flex-wrap gap-1.5">{props.children}</div>
    </div>
  );
}

function FilterFields(props: {
  filters: LeadFilters;
  onChange: (next: LeadFilters) => void;
}): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const options = useFilterOptions();
  const { filters, onChange } = props;
  const [source, setSource] = useState(filters.source);

  // The source box is free text: wait for a pause before asking the API.
  useEffect(() => {
    if (source === filters.source) return;
    const timer = setTimeout(
      () => onChange({ ...filters, source }),
      SOURCE_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [source, filters, onChange]);
  // A cleared filter (chip or "Clear all") resets the draft too.
  useEffect(() => setSource(filters.source), [filters.source]);

  const update = (patch: Partial<LeadFilters>): void =>
    onChange({ ...filters, ...patch });
  const labelClass = 'flex min-w-0 flex-col gap-1 text-sm font-medium';
  const activePreset = PRESETS.find((preset) => {
    const range = presetRange(preset);
    return (
      range.createdFrom === filters.createdFrom &&
      range.createdTo === filters.createdTo
    );
  });

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <FilterGroup label={t('leads.filterCreated')}>
        {PRESETS.map((preset) => (
          <ChoiceChip
            key={preset}
            testId={`leads-preset-${preset}`}
            selected={activePreset === preset}
            onClick={() =>
              update(
                activePreset === preset
                  ? { createdFrom: '', createdTo: '' }
                  : presetRange(preset),
              )
            }
          >
            {t(`leads.preset.${preset}`)}
          </ChoiceChip>
        ))}
      </FilterGroup>
      <div className="flex min-w-0 flex-wrap gap-2">
        <label className={`${labelClass} flex-1 basis-32`}>
          {t('leads.createdFrom')}
          <input
            type="date"
            value={filters.createdFrom}
            onChange={(e) => update({ createdFrom: e.target.value })}
            className={fieldClass}
          />
        </label>
        <label className={`${labelClass} flex-1 basis-32`}>
          {t('leads.createdTo')}
          <input
            type="date"
            value={filters.createdTo}
            onChange={(e) => update({ createdTo: e.target.value })}
            className={fieldClass}
          />
        </label>
      </div>
      <FilterGroup label={t('leads.filterChannel')}>
        {FILTER_CHANNELS.map((channel) => (
          <ChoiceChip
            key={channel}
            testId={`leads-channel-${channel}`}
            selected={filters.channel === channel}
            onClick={() =>
              update({ channel: filters.channel === channel ? '' : channel })
            }
          >
            {channelFilterLabel(channel, t)}
          </ChoiceChip>
        ))}
      </FilterGroup>
      <label className={labelClass}>
        {t('leads.filterOwner')}
        <Select
          field
          data-testid="leads-owner-filter"
          value={filters.ownerId}
          onChange={(e) => update({ ownerId: e.target.value })}
          className="w-full"
        >
          <option value="">{t('leads.anyOwner')}</option>
          <option value={operator.id}>{t('leads.mine')}</option>
          <option value="none">{t('leads.unassigned')}</option>
          {options.operators
            .filter((o) => o.isActive && o.id !== operator.id)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.displayName}
              </option>
            ))}
        </Select>
      </label>
      <FilterGroup label={t('leads.filterScore')}>
        {SCORES.map((score) => (
          <ChoiceChip
            key={score}
            testId={`leads-score-${score}`}
            selected={filters.score === score}
            onClick={() =>
              update({ score: filters.score === score ? '' : score })
            }
          >
            {t(`score.${score}`)}
          </ChoiceChip>
        ))}
      </FilterGroup>
      <FilterGroup label={t('leads.filterTask')}>
        {TASKS.map((task) => (
          <ChoiceChip
            key={task}
            testId={`leads-task-${task}`}
            selected={filters.task === task}
            onClick={() => update({ task: filters.task === task ? '' : task })}
          >
            {t(`leads.task.${task}`)}
          </ChoiceChip>
        ))}
      </FilterGroup>
      <label className={labelClass}>
        {t('people.filterByTag')}
        <Select
          field
          data-testid="leads-tag-filter"
          value={filters.tagId}
          onChange={(e) => update({ tagId: e.target.value })}
          className="w-full"
        >
          <option value="">{t('people.allTags')}</option>
          {options.tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </Select>
      </label>
      <details
        className="min-w-0 rounded-lg border border-line"
        open={
          filters.source !== '' ||
          filters.closeAfter !== '' ||
          filters.closeBefore !== ''
        }
      >
        <summary className="flex min-h-9 cursor-pointer items-center px-3 text-sm font-medium">
          {t('leads.filterMore')}
        </summary>
        <div className="flex min-w-0 flex-col gap-3 border-t border-line p-3">
          <label className={labelClass}>
            {t('leads.filterSource')}
            <input
              value={source}
              maxLength={60}
              onChange={(e) => setSource(e.target.value)}
              className={fieldClass}
            />
          </label>
          <div className="flex min-w-0 flex-wrap gap-2">
            <label className={`${labelClass} flex-1 basis-32`}>
              {t('leads.filterCloseAfter')}
              <input
                type="date"
                value={filters.closeAfter}
                onChange={(e) => update({ closeAfter: e.target.value })}
                className={fieldClass}
              />
            </label>
            <label className={`${labelClass} flex-1 basis-32`}>
              {t('leads.filterCloseBefore')}
              <input
                type="date"
                value={filters.closeBefore}
                onChange={(e) => update({ closeBefore: e.target.value })}
                className={fieldClass}
              />
            </label>
          </div>
        </div>
      </details>
    </div>
  );
}

/** "Filters" button with the active count: a popover on md+, a dialog below. */
export function FiltersMenu(props: {
  filters: LeadFilters;
  onChange: (next: LeadFilters) => void;
  isMobile: boolean;
}): ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const count = activeFilterCount(props.filters);

  useEffect(() => {
    if (!open || props.isMobile) return;
    const onDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, props.isMobile]);

  const clear = (): void => props.onChange(clearedFilters(props.filters));

  return (
    <div
      ref={rootRef}
      data-testid="leads-filters"
      className="relative min-w-0"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open && !props.isMobile) {
          event.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid="leads-filters-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2"
      >
        <Icon name="sliders" />
        {t('leads.filters')}
        {count > 0 ? (
          <Badge tone="accent" data-testid="leads-filters-count">
            {count}
            <span className="sr-only"> {t('leads.filtersActive')}</span>
          </Badge>
        ) : null}
      </button>
      {open && !props.isMobile ? (
        <div
          id={panelId}
          role="group"
          aria-label={t('leads.filters')}
          className="absolute left-0 top-full z-30 mt-1 flex max-h-[min(80dvh,42rem)] w-[min(92vw,24rem)] flex-col gap-3 overflow-y-auto rounded-xl border border-line bg-surface p-3 shadow-pop"
        >
          <FilterFields filters={props.filters} onChange={props.onChange} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={count === 0}
              onClick={clear}
            >
              {t('leads.clearAll')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
            >
              {t('leads.filtersDone')}
            </Button>
          </div>
        </div>
      ) : null}
      {props.isMobile ? (
        <FormDialog
          open={open}
          title={t('leads.filters')}
          testId="leads-filters-dialog"
          onClose={() => setOpen(false)}
          onSubmit={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" disabled={count === 0} onClick={clear}>
                {t('leads.clearAll')}
              </Button>
              <Button type="submit" variant="primary">
                {t('leads.filtersDone')}
              </Button>
            </>
          }
        >
          <FilterFields filters={props.filters} onChange={props.onChange} />
        </FormDialog>
      ) : null}
    </div>
  );
}

/** Active filters as removable chips, plus "Clear all". */
export function FilterChips(props: {
  filters: LeadFilters;
  onChange: (next: LeadFilters) => void;
}): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const options = useFilterOptions();
  const { filters } = props;
  if (activeFilterCount(filters) === 0) return null;

  const chips: Array<{ key: keyof LeadFilters; label: string }> = [];
  if (filters.ownerId)
    chips.push({
      key: 'ownerId',
      label: `${t('leads.filterOwner')}: ${
        filters.ownerId === 'none'
          ? t('leads.unassigned')
          : filters.ownerId === operator.id
            ? t('leads.mine')
            : (options.operators.find((o) => o.id === filters.ownerId)
                ?.displayName ?? filters.ownerId)
      }`,
    });
  if (filters.channel)
    chips.push({
      key: 'channel',
      label: `${t('leads.filterChannel')}: ${channelFilterLabel(filters.channel, t)}`,
    });
  if (filters.score)
    chips.push({
      key: 'score',
      label: `${t('leads.filterScore')}: ${t(`score.${filters.score}`)}`,
    });
  if (filters.task)
    chips.push({
      key: 'task',
      label: `${t('leads.filterTask')}: ${t(`leads.task.${filters.task}`)}`,
    });
  if (filters.source)
    chips.push({
      key: 'source',
      label: `${t('leads.filterSource')}: ${filters.source}`,
    });
  if (filters.closeAfter)
    chips.push({
      key: 'closeAfter',
      label: `${t('leads.filterCloseAfter')}: ${filters.closeAfter}`,
    });
  if (filters.closeBefore)
    chips.push({
      key: 'closeBefore',
      label: `${t('leads.filterCloseBefore')}: ${filters.closeBefore}`,
    });
  if (filters.createdFrom)
    chips.push({
      key: 'createdFrom',
      label: `${t('leads.createdFrom')}: ${filters.createdFrom}`,
    });
  if (filters.createdTo)
    chips.push({
      key: 'createdTo',
      label: `${t('leads.createdTo')}: ${filters.createdTo}`,
    });
  if (filters.tagId)
    chips.push({
      key: 'tagId',
      label: `${t('people.filterByTag')}: ${
        options.tags.find((tag) => tag.id === filters.tagId)?.name ??
        filters.tagId
      }`,
    });

  return (
    <ul
      data-testid="leads-filter-chips"
      aria-label={t('leads.activeFilters')}
      className="flex min-w-0 flex-wrap items-center gap-1.5"
    >
      {chips.map((chip) => (
        <li key={chip.key} className="min-w-0 max-w-full">
          <button
            type="button"
            data-testid={`leads-filter-chip-${chip.key}`}
            aria-label={t('leads.removeFilter', { filter: chip.label })}
            onClick={() => props.onChange({ ...filters, [chip.key]: '' })}
            className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full bg-primary-soft px-3 text-xs font-medium text-primary-fg hover:bg-surface-2"
          >
            <span className="min-w-0 truncate">{chip.label}</span>
            <span aria-hidden="true">×</span>
          </button>
        </li>
      ))}
      <li>
        <Button
          size="sm"
          variant="ghost"
          data-testid="leads-clear-all"
          onClick={() => props.onChange(clearedFilters(filters))}
        >
          {t('leads.clearAll')}
        </Button>
      </li>
    </ul>
  );
}
