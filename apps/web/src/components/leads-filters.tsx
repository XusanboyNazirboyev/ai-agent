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
import { FormDialog } from './ui/form-dialog';
import { Icon } from './ui/icons';
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

export function activeFilterCount(filters: LeadFilters): number {
  return Object.values(filters).filter((v) => v).length;
}

function FilterFields(props: {
  filters: LeadFilters;
  onChange: (next: LeadFilters) => void;
}): ReactNode {
  const { t } = useI18n();
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

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {options.manager ? (
        <label className={labelClass}>
          {t('leads.filterOwner')}
          <select
            value={filters.ownerId}
            onChange={(e) => update({ ownerId: e.target.value })}
            className={fieldClass}
          >
            <option value="">{t('leads.anyOwner')}</option>
            {options.operators
              .filter((o) => o.isActive)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName}
                </option>
              ))}
          </select>
        </label>
      ) : null}
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
      <label className={labelClass}>
        {t('people.filterByTag')}
        <select
          data-testid="leads-tag-filter"
          value={filters.tagId}
          onChange={(e) => update({ tagId: e.target.value })}
          className={fieldClass}
        >
          <option value="">{t('people.allTags')}</option>
          {options.tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </label>
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

  const clear = (): void => props.onChange(NO_FILTERS);

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
          className="absolute left-0 top-full z-30 mt-1 flex w-[min(92vw,22rem)] flex-col gap-3 rounded-xl border border-line bg-surface p-3 shadow-pop"
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
  const options = useFilterOptions();
  const { filters } = props;
  if (activeFilterCount(filters) === 0) return null;

  const chips: Array<{ key: keyof LeadFilters; label: string }> = [];
  if (filters.ownerId)
    chips.push({
      key: 'ownerId',
      label: `${t('leads.filterOwner')}: ${
        options.operators.find((o) => o.id === filters.ownerId)?.displayName ??
        filters.ownerId
      }`,
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
          onClick={() => props.onChange(NO_FILTERS)}
        >
          {t('leads.clearAll')}
        </Button>
      </li>
    </ul>
  );
}
