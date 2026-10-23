import type { ServerResponse } from 'node:http';
import { json, startHttpServer, type LocalServer } from './local-http.js';

/**
 * A fictional CRM REST API for GenericRestConnector tests.
 *
 * Every name, field and price is invented for tests and does not describe any
 * real CRM. Its field names are deliberately non-canonical (`uid`, `name`,
 * `cost.value`, `free_seats`) so tests prove that configured mappings do the
 * translation. Requests must carry `Authorization: Bearer <token>`.
 */

export const FICTIONAL_CRM_TOKEN = 'fictional-test-token';

interface FictionalGroup {
  gid: string;
  course_uid: string;
  cost?: { value: string; ccy: string };
  basis: string;
  state: string;
  free_seats: number;
  start: string;
  end: string;
}

export const FICTIONAL_COURSES = [
  {
    uid: 'course-a',
    name: 'Fictional Course Alpha',
    summary: 'Sample A',
    level: 'B1',
  },
  {
    uid: 'course-b',
    name: 'Fictional Course Beta',
    summary: 'Sample B',
    level: 'A2',
  },
  {
    uid: 'course-c',
    name: 'Fictional Course Gamma',
    summary: 'Sample C',
    level: 'B1',
  },
];

const GROUPS: FictionalGroup[] = [
  {
    gid: 'group-a1',
    course_uid: 'course-a',
    cost: { value: '150.00', ccy: 'usd' },
    basis: 'per person',
    state: 'open',
    free_seats: 12,
    start: '2026-11-02T18:00:00+05:00',
    end: '2026-12-14T20:00:00+05:00',
  },
  {
    gid: 'group-a2',
    course_uid: 'course-a',
    basis: 'total',
    state: 'sold-out',
    free_seats: 0,
    start: '2026-11-07T10:00:00+05:00',
    end: '2026-12-19T12:00:00+05:00',
  },
];

function notFound(response: ServerResponse): void {
  json(response, 404, { error: 'not found' });
}

export async function startFictionalCrm(): Promise<LocalServer> {
  let leadCounter = 0;
  let bookingCounter = 0;

  return startHttpServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${FICTIONAL_CRM_TOKEN}`) {
      json(response, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://fictional.invalid');
    const path = url.pathname;
    let match: RegExpExecArray | null;

    if (request.method === 'GET' && path === '/api/v1/courses') {
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const skip = Number(url.searchParams.get('skip') ?? '0');
      json(response, 200, {
        results: FICTIONAL_COURSES.slice(skip, skip + limit),
      });
      return;
    }
    if (request.method === 'GET' && path === '/api/v1/courses/search') {
      const name = (url.searchParams.get('name') ?? '').toLowerCase();
      const level = url.searchParams.get('level');
      json(response, 200, {
        results: FICTIONAL_COURSES.filter(
          (course) =>
            course.name.toLowerCase().includes(name) &&
            (level === null || course.level === level),
        ).slice(0, Number(url.searchParams.get('limit') ?? '50')),
      });
      return;
    }
    if (
      request.method === 'GET' &&
      (match = /^\/api\/v1\/courses\/([^/]+)\/groups$/.exec(path))
    ) {
      const courseId = decodeURIComponent(match[1]);
      if (!FICTIONAL_COURSES.some((course) => course.uid === courseId)) {
        notFound(response);
        return;
      }
      json(response, 200, {
        groups: GROUPS.filter((group) => group.course_uid === courseId),
      });
      return;
    }
    if (
      request.method === 'GET' &&
      (match = /^\/api\/v1\/courses\/([^/]+)$/.exec(path))
    ) {
      const course = FICTIONAL_COURSES.find(
        (entry) => entry.uid === decodeURIComponent(match![1]),
      );
      if (!course) {
        notFound(response);
        return;
      }
      json(response, 200, { course });
      return;
    }
    if (
      request.method === 'POST' &&
      (match = /^\/api\/v1\/groups\/([^/]+)\/(availability|quote)$/.exec(path))
    ) {
      const group = GROUPS.find(
        (entry) => entry.gid === decodeURIComponent(match![1]),
      );
      if (!group) {
        notFound(response);
        return;
      }
      if (match[2] === 'availability') {
        json(response, 200, {
          state: group.state,
          free_seats: group.free_seats,
          valid_until: '2026-10-23T12:00:00+05:00',
        });
        return;
      }
      if (!group.cost) {
        notFound(response);
        return;
      }
      json(response, 200, {
        quote: {
          ref: `q-${group.gid}`,
          total: group.cost.value,
          ccy: group.cost.ccy,
          basis: group.basis,
          valid_until: '2026-10-23T12:00:00+05:00',
        },
      });
      return;
    }
    if (request.method === 'POST' && path === '/api/v1/leads') {
      leadCounter++;
      json(response, 201, { lead: { lead_id: `lead-${leadCounter}` } });
      return;
    }
    if (
      request.method === 'PATCH' &&
      (match = /^\/api\/v1\/leads\/([^/]+)$/.exec(path))
    ) {
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'POST' && path === '/api/v1/bookings') {
      bookingCounter++;
      json(response, 201, { booking_ref: `booking-${bookingCounter}` });
      return;
    }
    notFound(response);
  });
}

/** Full GenericRestConnector config for the fictional CRM. */
export function fictionalCrmConfig(port: number): Record<string, unknown> {
  return {
    baseUrl: `http://fictional-crm.test:${port}/api/v1`,
    catalogItemType: 'course',
    auth: { type: 'bearer', secretRef: 'env:CONNECTOR_SECRET_FICTIONAL_CRM' },
    maxRetries: 0,
    endpoints: {
      listItems: {
        path: '/courses',
        dataPath: 'results',
        pagination: {
          strategy: 'offset',
          limitParam: 'limit',
          offsetParam: 'skip',
          pageSize: 2,
        },
      },
      searchItems: {
        path: '/courses/search',
        dataPath: 'results',
        searchParams: { title: 'name', attributes: { level: 'level' } },
      },
      getItem: { path: '/courses/{sourceEntityId}', itemPath: 'course' },
      getOffers: { path: '/courses/{itemId}/groups', dataPath: 'groups' },
      checkAvailability: {
        method: 'POST',
        path: '/groups/{offerId}/availability',
      },
      getQuote: {
        method: 'POST',
        path: '/groups/{offerId}/quote',
        itemPath: 'quote',
      },
      createLead: { method: 'POST', path: '/leads', itemPath: 'lead' },
      updateLead: { method: 'PATCH', path: '/leads/{crmLeadId}' },
      createBooking: { method: 'POST', path: '/bookings' },
    },
    fieldMappings: {
      item: {
        sourceEntityId: 'uid',
        title: 'name',
        description: 'summary',
        attributes: { level: 'level' },
      },
      offer: {
        sourceEntityId: 'gid',
        itemId: 'course_uid',
        priceAmount: 'cost.value',
        priceCurrency: 'cost.ccy',
        pricingBasis: 'basis',
        availabilityStatus: 'state',
        seatsLeft: 'free_seats',
        startsAt: 'start',
        endsAt: 'end',
      },
      availability: {
        status: 'state',
        seatsLeft: 'free_seats',
        validUntil: 'valid_until',
      },
      quote: {
        quoteId: 'ref',
        amount: 'total',
        currency: 'ccy',
        pricingBasis: 'basis',
        validUntil: 'valid_until',
      },
      lead: { crmLeadId: 'lead_id' },
      booking: { bookingId: 'booking_ref' },
    },
  };
}
