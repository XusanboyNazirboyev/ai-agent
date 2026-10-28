import type { Bitrix24Transport } from '../bitrix24-client.js';
import {
  COMMENT_ADDED,
  MODE_CLASSIC,
  itemAddResponse,
  itemListResponse,
} from './bitrix24-fixtures.js';

export interface FakeLead {
  readonly id: number;
  readonly fields: Record<string, unknown>;
}

export interface FakeCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

type Reply = { status: number; body: unknown };

/**
 * In-memory Bitrix24 portal answering in the recorded response shapes
 * (bitrix24-fixtures.ts). Tests queue one-off replies per method to simulate
 * limits and errors.
 */
export class FakePortal {
  readonly calls: FakeCall[] = [];
  readonly leads: FakeLead[] = [];
  readonly comments: Array<{ leadId: number; text: string }> = [];
  /** Phone -> matching IDs per entity type (contacts seeded by tests). */
  readonly contactsByPhone = new Map<string, number>();
  mode = 1;
  private nextId = 10;
  private readonly queued = new Map<string, Reply[]>();

  /** The next call of `method` gets `reply` instead of normal handling. */
  queue(method: string, reply: Reply): void {
    const list = this.queued.get(method) ?? [];
    list.push(reply);
    this.queued.set(method, list);
  }

  readonly transport: Bitrix24Transport = async (url, body) => {
    const method = /\/([a-z.]+)\.json$/u.exec(url)?.[1] ?? '';
    const params = (body ?? {}) as Record<string, unknown>;
    this.calls.push({ method, params });
    const queued = this.queued.get(method)?.shift();
    if (queued) return queued;
    return { status: 200, body: this.handle(method, params) };
  };

  private handle(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'crm.settings.mode.get':
        return { ...MODE_CLASSIC, result: this.mode };
      case 'crm.item.add': {
        const fields = params.fields as Record<string, unknown>;
        const id = this.nextId++;
        this.leads.push({ id, fields });
        return itemAddResponse(id, fields);
      }
      case 'crm.item.list': {
        const filter = (params.filter ?? {}) as Record<string, unknown>;
        const ids = this.leads
          .filter((lead) =>
            Object.entries(filter).every(
              ([key, value]) => lead.fields[key] === value,
            ),
          )
          .map((lead) => lead.id);
        return itemListResponse(ids);
      }
      case 'crm.duplicate.findbycomm': {
        const phone = (params.values as string[])[0] ?? '';
        const leads = this.leads
          .filter((lead) =>
            ((lead.fields.fm ?? []) as Array<{ value?: string }>).some(
              (entry) => entry.value === phone,
            ),
          )
          .map((lead) => lead.id);
        const contact = this.contactsByPhone.get(phone);
        if (!leads.length && contact === undefined) return { result: [] };
        return {
          result: {
            ...(leads.length ? { LEAD: leads } : {}),
            ...(contact !== undefined ? { CONTACT: [contact] } : {}),
          },
        };
      }
      case 'crm.timeline.comment.add': {
        const fields = params.fields as Record<string, unknown>;
        this.comments.push({
          leadId: Number(fields.ENTITY_ID),
          text: String(fields.COMMENT),
        });
        return COMMENT_ADDED;
      }
      case 'crm.timeline.comment.list': {
        const filter = (params.filter ?? {}) as Record<string, unknown>;
        // DOCS shape (crm.timeline.comment.list): a list of comments; newest first.
        return {
          result: this.comments
            .map((comment, index) => ({ ID: index + 1, ...comment }))
            .filter((comment) => comment.leadId === Number(filter.ENTITY_ID))
            .reverse()
            .map(({ ID, text }) => ({ ID, COMMENT: text })),
        };
      }
      default:
        return { error: 'ERROR_METHOD_NOT_FOUND' };
    }
  }

  callsOf(method: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}
