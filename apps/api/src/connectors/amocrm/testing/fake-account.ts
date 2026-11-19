import type { AmocrmRequest, AmocrmTransport } from '../amocrm-client.js';
import {
  accountResponse,
  complexResponse,
  DEFAULT_PIPELINES,
  leadsResponse,
  pipelinesResponse,
  TEST_SUBDOMAIN,
  TEST_TOKEN,
  type PipelineSpec,
} from './amocrm-fixtures.js';

export interface FakeLead {
  id: number;
  statusId: number;
  pipelineId: number;
  updatedAt: number;
  isDeleted: boolean;
  body: Record<string, unknown>;
}

export interface FakeCall {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly body: unknown;
  readonly authorization: string | undefined;
  readonly host: string;
}

type Reply = { status: number; body: unknown };

/**
 * In-memory amoCRM account answering in the official response shapes
 * (amocrm-fixtures.ts). Tests queue one-off replies per path to simulate
 * limits and errors.
 */
export class FakeAccount {
  readonly calls: FakeCall[] = [];
  readonly leads: FakeLead[] = [];
  pipelines: PipelineSpec[] = structuredClone(DEFAULT_PIPELINES);
  /** Token the account accepts; any other gets 401. */
  token = TEST_TOKEN;
  private nextId = 100;
  private readonly queued = new Map<string, Reply[]>();

  queue(path: string, reply: Reply): void {
    const list = this.queued.get(path) ?? [];
    list.push(reply);
    this.queued.set(path, list);
  }

  readonly transport: AmocrmTransport = async (request: AmocrmRequest) => {
    const url = new URL(request.url);
    const call: FakeCall = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: request.body,
      authorization: request.headers.authorization,
      host: url.host,
    };
    this.calls.push(call);
    const queued = this.queued.get(call.path)?.shift();
    if (queued) return queued;
    if (call.authorization !== `Bearer ${this.token}`)
      return { status: 401, body: { title: 'Unauthorized', status: 401 } };
    return this.handle(call);
  };

  private handle(call: FakeCall): Reply {
    if (call.method === 'GET' && call.path === '/api/v4/account')
      return { status: 200, body: accountResponse() };
    if (call.method === 'GET' && call.path === '/api/v4/leads/pipelines')
      return { status: 200, body: pipelinesResponse(this.pipelines) };
    if (call.method === 'GET' && call.path === '/api/v4/leads') {
      const from = Number(call.query['filter[updated_at][from]'] ?? 0);
      const pipeline = call.query['filter[pipeline_id][0]'];
      const page = Number(call.query.page ?? 1);
      const limit = Number(call.query.limit ?? 50);
      const rows = this.leads
        .filter(
          (l) =>
            l.updatedAt >= from &&
            (pipeline === undefined || String(l.pipelineId) === pipeline),
        )
        .sort((a, b) => a.updatedAt - b.updatedAt || a.id - b.id)
        .slice((page - 1) * limit, page * limit);
      // amoCRM answers an empty list with 204 and no body.
      if (rows.length === 0) return { status: 204, body: undefined };
      return {
        status: 200,
        body: leadsResponse(
          rows.map((l) => ({
            id: l.id,
            status_id: l.statusId,
            pipeline_id: l.pipelineId,
            updated_at: l.updatedAt,
            is_deleted: l.isDeleted,
          })),
        ),
      };
    }
    if (call.method === 'POST' && call.path === '/api/v4/leads/complex') {
      const rows = (call.body as Array<Record<string, unknown>>).map((body) => {
        const id = this.nextId++;
        const main = this.pipelines[0];
        this.leads.push({
          id,
          statusId: Number(body.status_id ?? main?.statuses[1]?.id ?? 0),
          pipelineId: Number(body.pipeline_id ?? main?.id ?? 0),
          updatedAt: Math.floor(Date.now() / 1000),
          isDeleted: false,
          body,
        });
        return { id, contactId: id + 1000, requestId: String(body.request_id) };
      });
      return { status: 200, body: complexResponse(rows) };
    }
    return { status: 404, body: {} };
  }

  /** A manager moves a lead to a stage (stage and time change). */
  moveLead(id: number, statusId: number, updatedAt: number): void {
    const lead = this.leads.find((l) => l.id === id);
    if (!lead) throw new Error(`no fake lead ${id}`);
    lead.statusId = statusId;
    lead.updatedAt = updatedAt;
  }

  callsTo(path: string): FakeCall[] {
    return this.calls.filter((call) => call.path === path);
  }
}

export { TEST_SUBDOMAIN, TEST_TOKEN };
