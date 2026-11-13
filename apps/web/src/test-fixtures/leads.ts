import type { BoardStageView, LeadPipelineItem } from '@/lib/types';

/** Shapes exactly as the funnel API returns them (ADR 058 contract). */
export const STAGES: BoardStageView[] = [
  {
    id: 'stage-new',
    code: 'NEW',
    name: 'New',
    kind: 'OPEN',
    position: 0,
    count: 1,
    totals: [
      { currency: 'UZS', amount: '150000.00' },
      { currency: 'USD', amount: '0.30' },
    ],
  },
  {
    id: 'stage-qual',
    code: 'QUALIFIED',
    name: 'Qualified',
    kind: 'OPEN',
    position: 1,
    count: 0,
    totals: [],
  },
  {
    id: 'stage-won',
    code: 'WON',
    name: 'Won',
    kind: 'WON',
    position: 2,
    count: 0,
    totals: [],
  },
  {
    id: 'stage-lost',
    code: 'LOST',
    name: 'Lost',
    kind: 'LOST',
    position: 3,
    count: 0,
    totals: [],
  },
];

export function makeLead(
  patch: Partial<LeadPipelineItem> = {},
): LeadPipelineItem {
  return {
    id: 'lead-1',
    pipelineId: 'pipe-1',
    pipelineStageId: 'stage-new',
    ownerOperatorId: 'op-9',
    owner: { id: 'op-9', displayName: 'Grace Hopper' },
    amount: '150000.00',
    currency: 'UZS',
    source: null,
    expectedCloseDate: null,
    lostReason: null,
    stageSetBy: 'OPERATOR',
    suggestedStageId: null,
    suggestedReasonCodes: [],
    score: 'HOT',
    status: 'NEW',
    summary: '',
    createdAt: '2026-11-11T09:00:00.000Z',
    updatedAt: '2026-11-11T10:00:00.000Z',
    contact: { name: 'Ada Lovelace', phone: '+998901234567' },
    conversation: {
      id: 'conv-1',
      state: 'BOT_ACTIVE',
      channelType: 'telegram',
    },
    tags: [],
    customFields: [],
    ...patch,
  };
}
