/**
 * Pure rules of the stage sync from Bitrix24 (ADR 079): parsing the portal's
 * answers, default mapping by stage semantics, and the polling cursor.
 * No I/O, so they are unit tested on their own.
 */

import type {
  PortalStage,
  StageSemantics,
} from '../interfaces/stage-sync-source.js';

export type { PortalStage, StageSemantics };

export interface PortalLeadChange {
  readonly id: number;
  readonly stageId: string;
  readonly updatedAt: Date;
}

/** Rows per `crm.item.list` page (docs: fixed at 50). */
export const PAGE_SIZE = 50;
/** Items looked at per connector per run. */
export const MAX_ITEMS_PER_RUN = 500;
/** The scan re-reads this long before its cursor (clock and commit skew). */
export const CURSOR_OVERLAP_MS = 60_000;
/** A claim on a connector; a crashed scan frees it after this. */
export const LEASE_MS = 5 * 60_000;
export const SCAN_INTERVAL_MS = 2 * 60_000;

/** Docs list `process`/`success`/`failure`/`apology`; short codes are accepted too. */
export function normalizeSemantics(value: unknown): StageSemantics {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'success' || text === 's') return 'success';
  if (text === 'failure' || text === 'f') return 'failure';
  if (text === 'apology' || text === 'a') return 'apology';
  return 'process';
}

/** Rows of `crm.status.list`; malformed rows are dropped. Ordered by SORT. */
export function parseStages(result: unknown): PortalStage[] {
  if (!Array.isArray(result)) return [];
  const stages: PortalStage[] = [];
  for (const row of result as unknown[]) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.STATUS_ID === 'string' ? r.STATUS_ID.trim() : '';
    if (!id || id.length > 100) continue;
    const name =
      typeof r.NAME === 'string' && r.NAME.trim()
        ? r.NAME.trim().slice(0, 200)
        : id;
    const sort = Number(r.SORT);
    stages.push({
      id,
      name,
      sort: Number.isFinite(sort) ? sort : 0,
      semantics: normalizeSemantics(r.SEMANTICS),
    });
  }
  return stages.sort((a, b) => a.sort - b.sort);
}

/** Items of `crm.item.list` (id, stageId, updatedTime); malformed items are dropped. */
export function parseChanges(result: unknown): PortalLeadChange[] {
  const items = (result as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const changes: PortalLeadChange[] = [];
  for (const item of items as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = Number(r.id);
    const updatedAt = new Date(String(r.updatedTime ?? ''));
    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      typeof r.stageId !== 'string' ||
      !r.stageId ||
      Number.isNaN(updatedAt.getTime())
    )
      continue;
    changes.push({ id, stageId: r.stageId, updatedAt });
  }
  return changes;
}

export interface OurStageRef {
  readonly id: string;
  readonly kind: 'OPEN' | 'WON' | 'LOST';
}

/**
 * Default target of a portal stage: success -> our WON stage, failure and
 * apology -> our LOST stage, process stages stay unmapped (null = ignore)
 * until the admin picks one.
 */
export function defaultTarget(
  semantics: StageSemantics,
  ours: readonly OurStageRef[],
): string | null {
  const kind =
    semantics === 'success'
      ? 'WON'
      : semantics === 'failure' || semantics === 'apology'
        ? 'LOST'
        : null;
  if (!kind) return null;
  return ours.find((stage) => stage.kind === kind)?.id ?? null;
}

/** Where a scan starts reading: the cursor minus the overlap. */
export function scanSince(cursor: Date): Date {
  return new Date(cursor.getTime() - CURSOR_OVERLAP_MS);
}

/**
 * The cursor after a run: the newest `updatedTime` among the items that were
 * fully processed, never moving backwards. Items past the first failure are
 * not counted, so they are read again next time.
 */
export function advanceCursor(
  current: Date,
  processed: readonly { readonly updatedAt: Date }[],
): Date {
  let next = current;
  for (const change of processed)
    if (change.updatedAt.getTime() > next.getTime()) next = change.updatedAt;
  return next;
}

/** The reason of a LOST move; capped like operator-typed reasons. */
export function lostReasonFor(
  stageName: string,
  max = 200,
  label = 'Bitrix24',
): string {
  return `${label}: ${stageName}`.slice(0, max);
}
