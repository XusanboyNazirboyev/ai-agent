/**
 * Responses shaped like the official examples (read 2026-11-19):
 * - account: https://www.amocrm.ru/developers/content/crm_platform/account
 * - pipelines: .../crm_platform/leads_pipelines (ids 142/143 and type 1/0)
 * - leads list and leads/complex: .../crm_platform/leads-api
 * Values are fictional.
 */
export const TEST_SUBDOMAIN = 'example';
export const TEST_TOKEN = 'synthetic-long-lived-token-0123456789';
export const MAIN_PIPELINE_ID = 3177727;
export const SECOND_PIPELINE_ID = 3177800;

export function accountResponse(): unknown {
  return {
    id: 1231414,
    name: 'example',
    subdomain: 'example',
    current_user_id: 581651,
    country: 'RU',
    is_unsorted_on: true,
    version: 16,
  };
}

export interface PipelineSpec {
  id: number;
  name: string;
  sort: number;
  isMain: boolean;
  isArchive?: boolean;
  statuses: Array<{ id: number; name: string; sort: number; type: number }>;
}

export const DEFAULT_PIPELINES: PipelineSpec[] = [
  {
    id: MAIN_PIPELINE_ID,
    name: 'Воронка',
    sort: 1,
    isMain: true,
    statuses: [
      { id: 32392156, name: 'Неразобранное', sort: 10, type: 1 },
      { id: 32392159, name: 'Первичный контакт', sort: 20, type: 0 },
      { id: 32392165, name: 'Принимают решение', sort: 30, type: 0 },
      { id: 142, name: 'Успешно реализовано', sort: 10000, type: 0 },
      { id: 143, name: 'Закрыто и не реализовано', sort: 11000, type: 0 },
    ],
  },
  {
    id: SECOND_PIPELINE_ID,
    name: 'Вторая воронка',
    sort: 2,
    isMain: false,
    statuses: [
      { id: 32400001, name: 'Новая', sort: 10, type: 0 },
      { id: 142, name: 'Успешно реализовано', sort: 10000, type: 0 },
      { id: 143, name: 'Закрыто и не реализовано', sort: 11000, type: 0 },
    ],
  },
];

export function pipelinesResponse(pipelines: PipelineSpec[]): unknown {
  return {
    _total_items: pipelines.length,
    _embedded: {
      pipelines: pipelines.map((p) => ({
        id: p.id,
        name: p.name,
        sort: p.sort,
        is_main: p.isMain,
        is_unsorted_on: true,
        is_archive: p.isArchive ?? false,
        account_id: 12345678,
        _embedded: {
          statuses: p.statuses.map((s) => ({
            id: s.id,
            name: s.name,
            sort: s.sort,
            is_editable: s.id !== 142 && s.id !== 143,
            pipeline_id: p.id,
            type: s.type,
            account_id: 12345678,
          })),
        },
      })),
    },
  };
}

export function leadsResponse(
  leads: Array<{
    id: number;
    status_id: number;
    pipeline_id: number;
    updated_at: number;
    is_deleted?: boolean;
  }>,
): unknown {
  return {
    _page: 1,
    _embedded: {
      leads: leads.map((l) => ({
        id: l.id,
        name: 'Lead',
        status_id: l.status_id,
        pipeline_id: l.pipeline_id,
        updated_at: l.updated_at,
        is_deleted: l.is_deleted ?? false,
      })),
    },
  };
}

/** `POST /api/v4/leads/complex` answer: one row per lead sent. */
export function complexResponse(
  rows: Array<{ id: number; contactId: number | null; requestId: string }>,
): unknown {
  return rows.map((r) => ({
    id: r.id,
    contact_id: r.contactId,
    company_id: null,
    request_id: [r.requestId],
    merged: false,
  }));
}
