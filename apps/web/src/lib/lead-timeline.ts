import { stageLabel } from '@/components/lead-board-utils';
import { reasonLabel } from './handover-text';

export type TimelineKind =
  | 'lead.created'
  | 'stage.moved'
  | 'lead.updated'
  | 'lead.archived'
  | 'task.created'
  | 'task.done'
  | 'note'
  | 'handover.opened'
  | 'handover.taken'
  | 'handover.resolved'
  | 'message';

export type TimelineActor = 'customer' | 'assistant' | 'operator' | 'system';

export interface TimelineStage {
  id: string;
  code: string | null;
  name: string | null;
  kind: string;
}

export interface TimelineEntry {
  id: string;
  at: string;
  kind: TimelineKind;
  actor: TimelineActor;
  actorName: string | null;
  text: string | null;
  from: TimelineStage | null;
  to: TimelineStage | null;
  reasonCode: string | null;
}

type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/** The one line a timeline entry reads as, in the operator's language. */
export function timelineLine(t: Translate, entry: TimelineEntry): string {
  const text = entry.text ?? t('timeline.noText');
  const stage = (value: TimelineStage | null): string =>
    value ? stageLabel(value, t) : '—';
  switch (entry.kind) {
    case 'message':
      return t(`timeline.message.${entry.actor}`, { text });
    case 'stage.moved':
      return t('timeline.kind.stage.moved', {
        from: stage(entry.from),
        to: stage(entry.to),
      });
    case 'handover.opened':
      return t('timeline.kind.handover.opened', {
        reason: entry.reasonCode ? reasonLabel(t, entry.reasonCode) : '—',
      });
    case 'task.created':
    case 'task.done':
    case 'note':
      return t(`timeline.kind.${entry.kind}`, { text });
    default:
      return t(`timeline.kind.${entry.kind}`);
  }
}
