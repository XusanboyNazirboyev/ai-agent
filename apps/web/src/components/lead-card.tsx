'use client';

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { channelName } from '@/lib/channel-names';
import { formatAmount } from '@/lib/currencies';
import type { BoardStageView, LeadPipelineItem } from '@/lib/types';
import { useShell } from './app-shell';
import { Avatar } from './ui/avatar';
import { Badge } from './ui/badge';
import {
  ageDays,
  ageTone,
  currentStageId,
  stageLabel,
} from './lead-board-utils';

const MAX_TAG_CHIPS = 2;

/**
 * A compact funnel card: scan and move. Editing lives in the lead panel
 * (ADR 058, UX standard): no inline selects or action buttons here.
 */
export function LeadCard(props: {
  item: LeadPipelineItem;
  stage: BoardStageView;
  stages: BoardStageView[];
  draggedId: string | null;
  draggedToStageId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onOpen: (item: LeadPipelineItem, opener: HTMLElement | null) => void;
  /** Move (or, for a LOST stage, ask for the reason) from the keyboard path. */
  onRequestMove: (item: LeadPipelineItem, toStageId: string) => void;
}): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const canEdit = ['OWNER', 'ADMIN', 'OPERATOR'].includes(operator.role);
  const openRef = useRef<HTMLButtonElement>(null);
  const { item, stages } = props;
  const stageId = currentStageId(item, stages);
  const isDragging = props.draggedId === item.id;
  const isDraggedHere = props.draggedToStageId === props.stage.id;
  const [keyboardDragging, setKeyboardDragging] = useState(false);
  const [keyboardTargetStage, setKeyboardTargetStage] = useState<string | null>(
    null,
  );
  const [keyboardStatus, setKeyboardStatus] = useState('');
  const pickedUp = isDragging || keyboardDragging;
  const name = item.contact.name ?? t('list.unnamed');
  const terminal = props.stage.kind !== 'OPEN';

  function cancelKeyboardDrag(): void {
    setKeyboardDragging(false);
    setKeyboardTargetStage(null);
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (!canEdit) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (!keyboardDragging) {
        setKeyboardDragging(true);
        setKeyboardTargetStage(stageId);
        setKeyboardStatus(t('leads.dragPickedUp'));
        return;
      }
      const target = keyboardTargetStage ?? stageId;
      const lost = stages.find((s) => s.id === target)?.kind === 'LOST';
      cancelKeyboardDrag();
      props.onRequestMove(item, target);
      setKeyboardStatus(
        t(lost ? 'leads.dragDroppedLost' : 'leads.dragDropped'),
      );
      return;
    }
    if (!keyboardDragging) return;
    if (e.key === 'Escape') {
      cancelKeyboardDrag();
      setKeyboardStatus(t('leads.dragCancelled'));
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const idx = stages.findIndex(
        (s) => s.id === (keyboardTargetStage ?? stageId),
      );
      const next =
        idx === -1
          ? 0
          : Math.min(
              Math.max(idx + (e.key === 'ArrowRight' ? 1 : -1), 0),
              stages.length - 1,
            );
      setKeyboardTargetStage(stages[next].id);
      setKeyboardStatus(
        t('leads.dragTarget', { stage: stageLabel(stages[next], t) }),
      );
    }
  }

  const tags = item.tags ?? [];
  const days = ageDays(item.updatedAt);
  const tone = ageTone(days);
  const suggested =
    item.suggestedStageId && item.suggestedStageId !== stageId
      ? stages.find((s) => s.id === item.suggestedStageId)
      : undefined;

  return (
    <li>
      {/* The name button is the keyboard path; the card area is a mouse convenience. */}
      <article
        data-testid="lead-card"
        data-state={pickedUp ? 'picked-up' : 'idle'}
        draggable={canEdit}
        onDragStart={() => props.onDragStart(item.id)}
        onDragEnd={props.onDragEnd}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button, a')) return;
          props.onOpen(item, openRef.current);
        }}
        className={`flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-xl border p-2.5 transition-colors hover:border-primary ${
          pickedUp
            ? 'border-primary bg-primary-soft ring-1 ring-primary'
            : isDraggedHere
              ? 'border-primary bg-canvas ring-2 ring-primary'
              : 'border-line bg-canvas'
        }`}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            ref={openRef}
            type="button"
            data-testid="lead-card-open"
            data-lead-open={item.id}
            aria-label={t('leads.openLead', { name })}
            onClick={() => props.onOpen(item, openRef.current)}
            className="min-h-9 min-w-0 flex-1 truncate rounded-md text-left text-sm font-semibold hover:text-primary-fg"
          >
            {name}
          </button>
          {canEdit ? (
            <>
              <button
                type="button"
                data-testid="lead-card-handle"
                aria-roledescription={t('leads.handleRole')}
                aria-pressed={keyboardDragging}
                aria-label={t('leads.moveHandle', { name })}
                onKeyDown={handleKeyDown}
                onBlur={() => {
                  cancelKeyboardDrag();
                  setKeyboardStatus('');
                }}
                className="grid min-h-9 min-w-9 cursor-grab place-items-center rounded-md text-muted hover:bg-surface-2"
              >
                <span aria-hidden="true">⠿</span>
              </button>
              <span
                aria-live="assertive"
                data-testid="lead-card-live"
                className="sr-only"
              >
                {keyboardStatus}
              </span>
            </>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {item.amount ? (
            <span
              data-testid="lead-card-amount"
              className="min-w-0 font-semibold text-fg"
            >
              {formatAmount(
                item.amount,
                item.currency,
                t('locale.uz-Latn') === 'uz-Latn' ? 'uz-Latn' : undefined,
              )}
            </span>
          ) : null}
          <span data-testid="lead-card-channel" className="min-w-0 truncate">
            {channelName(item.conversation.channelType)}
          </span>
          {item.owner ? (
            <span
              role="img"
              data-testid="lead-card-owner-name"
              title={item.owner.displayName}
              aria-label={t('leads.ownerLabel', {
                name: item.owner.displayName,
              })}
              className="ml-auto"
            >
              <Avatar name={item.owner.displayName} size="xs" />
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {tags.slice(0, MAX_TAG_CHIPS).map((tag) => (
            <Badge
              key={tag.id}
              data-testid="lead-card-tag"
              className="max-w-full min-w-0"
            >
              <span className="truncate">{tag.name}</span>
            </Badge>
          ))}
          {tags.length > MAX_TAG_CHIPS ? (
            <Badge data-testid="lead-card-tag-more">
              +{tags.length - MAX_TAG_CHIPS}
            </Badge>
          ) : null}
          {item.stageSetBy === 'AGENT' ? (
            <Badge tone="accent" data-testid="lead-card-stage-by-ai">
              {t('leads.aiChip')}
            </Badge>
          ) : null}
          {!terminal ? (
            <Badge
              tone={tone}
              dot={tone !== 'neutral'}
              data-testid="lead-card-age"
            >
              <span aria-hidden="true">{t('leads.ageDays', { days })}</span>
              <span className="sr-only">{t('leads.ageLabel', { days })}</span>
            </Badge>
          ) : null}
        </div>
        {suggested ? (
          <button
            type="button"
            data-testid="lead-card-stage-suggested"
            onClick={() => props.onOpen(item, openRef.current)}
            className="inline-flex min-h-9 min-w-0 max-w-full items-center rounded-full bg-warning-soft px-2.5 text-left text-xs font-medium text-warning-fg"
          >
            <span className="truncate">
              {t('leads.aiSuggestsChip', { stage: stageLabel(suggested, t) })}
            </span>
          </button>
        ) : null}
      </article>
    </li>
  );
}
