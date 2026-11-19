/**
 * Pure rules of the amoCRM stage sync and lead creation (ADR 081): parsing
 * the account's answers and the default stage mapping. No I/O. Response
 * shapes follow the official examples (read 2026-11-19):
 * https://www.amocrm.ru/developers/content/crm_platform/leads_pipelines
 * https://www.amocrm.ru/developers/content/crm_platform/leads-api
 */
import type {
  PortalStage,
  SyncLeadChange,
} from '../interfaces/stage-sync-source.js';

/** System stage "successfully realised" of every pipeline. */
export const WON_STATUS_ID = 142;
/** System stage "closed and not realised" of every pipeline. */
export const LOST_STATUS_ID = 143;
/** `type` of a pipeline stage: 1 = the "unsorted" inbox, 0 = a normal stage. */
const UNSORTED_TYPE = 1;
/** Leads per `GET /api/v4/leads` page (docs: at most 250). */
export const LEADS_PAGE_SIZE = 250;

export interface AmocrmPipeline {
  readonly id: number;
  readonly name: string;
  readonly sort: number;
  readonly isMain: boolean;
}

export interface AmocrmStatus {
  readonly id: number;
  readonly name: string;
  readonly sort: number;
  readonly type: number;
}

function posInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function pipelineRows(result: unknown): Record<string, unknown>[] {
  const rows = (result as { _embedded?: { pipelines?: unknown } } | null)
    ?._embedded?.pipelines;
  return Array.isArray(rows)
    ? rows.filter(
        (row): row is Record<string, unknown> =>
          row !== null && typeof row === 'object',
      )
    : [];
}

/** Active pipelines of `GET /api/v4/leads/pipelines`, ordered by sort. */
export function parsePipelines(result: unknown): AmocrmPipeline[] {
  const out: AmocrmPipeline[] = [];
  for (const row of pipelineRows(result)) {
    const id = posInt(row.id);
    if (id === undefined || row.is_archive === true) continue;
    out.push({
      id,
      name:
        typeof row.name === 'string' && row.name.trim()
          ? row.name.trim().slice(0, 200)
          : String(id),
      sort: Number.isFinite(Number(row.sort)) ? Number(row.sort) : 0,
      isMain: row.is_main === true,
    });
  }
  return out.sort((a, b) => a.sort - b.sort);
}

/** Stages of one pipeline, ordered by sort; the unsorted inbox is dropped. */
export function parseStatuses(
  result: unknown,
  pipelineId: number,
): AmocrmStatus[] {
  const pipeline = pipelineRows(result).find(
    (row) => posInt(row.id) === pipelineId,
  );
  const rows = (pipeline?._embedded as { statuses?: unknown } | undefined)
    ?.statuses;
  if (!Array.isArray(rows)) return [];
  const out: AmocrmStatus[] = [];
  for (const row of rows as unknown[]) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = posInt(r.id);
    const type = Number(r.type ?? 0);
    if (id === undefined || type === UNSORTED_TYPE) continue;
    out.push({
      id,
      name:
        typeof r.name === 'string' && r.name.trim()
          ? r.name.trim().slice(0, 200)
          : String(id),
      sort: Number.isFinite(Number(r.sort)) ? Number(r.sort) : 0,
      type,
    });
  }
  return out.sort((a, b) => a.sort - b.sort);
}

/** 142 is success and 143 is failure; every other stage is a process stage. */
export function toPortalStages(
  statuses: readonly AmocrmStatus[],
): PortalStage[] {
  return statuses.map((status) => ({
    id: String(status.id),
    name: status.name,
    sort: status.sort,
    semantics:
      status.id === WON_STATUS_ID
        ? 'success'
        : status.id === LOST_STATUS_ID
          ? 'failure'
          : 'process',
  }));
}

/** Where new leads start: the first normal stage that is not 142 or 143. */
export function firstOpenStatus(
  statuses: readonly AmocrmStatus[],
): AmocrmStatus | undefined {
  return statuses.find(
    (status) => status.id !== WON_STATUS_ID && status.id !== LOST_STATUS_ID,
  );
}

/**
 * Leads of `GET /api/v4/leads` (`_embedded.leads`); malformed, deleted and
 * other-pipeline leads are dropped. `updated_at` is a Unix time in seconds.
 */
export function parseLeadChanges(
  result: unknown,
  pipelineId: number,
): SyncLeadChange[] {
  const leads = (result as { _embedded?: { leads?: unknown } } | null)
    ?._embedded?.leads;
  if (!Array.isArray(leads)) return [];
  const out: SyncLeadChange[] = [];
  for (const lead of leads as unknown[]) {
    if (lead === null || typeof lead !== 'object') continue;
    const r = lead as Record<string, unknown>;
    const id = posInt(r.id);
    const status = posInt(r.status_id);
    const updated = Number(r.updated_at);
    if (
      id === undefined ||
      status === undefined ||
      !Number.isFinite(updated) ||
      r.is_deleted === true ||
      (r.pipeline_id !== undefined && posInt(r.pipeline_id) !== pipelineId)
    )
      continue;
    out.push({
      externalId: String(id),
      stageId: String(status),
      updatedAt: new Date(updated * 1000),
    });
  }
  return out;
}
