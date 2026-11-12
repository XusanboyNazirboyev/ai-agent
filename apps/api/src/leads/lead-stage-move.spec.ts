import { describe, expect, it } from 'vitest';
import { moveLeadToStage } from './lead-stage-move.js';

type Kind = 'OPEN' | 'WON' | 'LOST';
interface LeadRow {
  id: string;
  pipelineId: string;
  pipelineStageId: string | null;
  status: string;
  lostReason: string | null;
}

function fake(
  lead: LeadRow | null,
  stage: { id: string; pipelineId: string; kind: Kind } | null,
) {
  const updates: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const queries: Array<Record<string, unknown>> = [];
  const tx = {
    lead: {
      findFirst: async (args: Record<string, unknown>) => {
        queries.push(args);
        return lead;
      },
      updateMany: async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return { count: 1 };
      },
    },
    leadStage: {
      findFirst: async (args: Record<string, unknown>) => {
        queries.push(args);
        return stage;
      },
    },
    auditEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        audits.push(args.data);
        return {};
      },
    },
  };
  return { tx: tx as never, updates, audits, queries };
}

const lead = (over: Partial<LeadRow> = {}): LeadRow => ({
  id: 'L',
  pipelineId: 'P',
  pipelineStageId: 'S0',
  status: 'NEW',
  lostReason: null,
  ...over,
});
const input = {
  tenantId: 'T',
  leadId: 'L',
  stageId: 'S1',
  actor: 'OPERATOR' as const,
  actorId: 'op',
};

describe('moveLeadToStage', () => {
  it('moves within OPEN stages, locks to the actor, clears the suggestion and audits', async () => {
    const f = fake(lead(), { id: 'S1', pipelineId: 'P', kind: 'OPEN' });
    const r = await moveLeadToStage(f.tx, {
      ...input,
      reasonCodes: ['a', 'b'],
    });
    expect(r).toMatchObject({
      moved: true,
      status: 'NEW',
      pipelineStageId: 'S1',
    });
    expect(f.updates[0]).toMatchObject({
      pipelineStageId: 'S1',
      stageSetBy: 'OPERATOR',
      suggestedStageId: null,
      suggestedReasonCodes: [],
    });
    expect(f.updates[0]).not.toHaveProperty('status');
    expect(f.audits[0]).toMatchObject({
      tenantId: 'T',
      action: 'lead.stage.moved',
      actorType: 'OPERATOR',
      actorId: 'op',
      safeInputSummary: {
        from: 'S0',
        to: 'S1',
        actor: 'OPERATOR',
        reasonCodes: 'a,b',
      },
    });
  });

  it('is tenant scoped on both reads and the write', async () => {
    const f = fake(lead(), { id: 'S1', pipelineId: 'P', kind: 'OPEN' });
    await moveLeadToStage(f.tx, input);
    for (const q of f.queries)
      expect((q as { where: { tenantId: string } }).where.tenantId).toBe('T');
  });

  it('a WON stage sets status WON', async () => {
    const f = fake(lead(), { id: 'S1', pipelineId: 'P', kind: 'WON' });
    const r = await moveLeadToStage(f.tx, input);
    expect(r.status).toBe('WON');
    expect(f.updates[0]).toMatchObject({ status: 'WON', lostReason: null });
  });

  it('a LOST stage needs a reason and stores it', async () => {
    const f = fake(lead(), { id: 'S1', pipelineId: 'P', kind: 'LOST' });
    await expect(moveLeadToStage(f.tx, input)).rejects.toMatchObject({
      response: { code: 'LOST_REASON_REQUIRED' },
    });
    await expect(
      moveLeadToStage(f.tx, { ...input, lostReason: '   ' }),
    ).rejects.toMatchObject({ response: { code: 'LOST_REASON_REQUIRED' } });
    expect(f.updates).toHaveLength(0);
    expect(f.audits).toHaveLength(0);
    const r = await moveLeadToStage(f.tx, {
      ...input,
      lostReason: ' too dear ',
    });
    expect(r.status).toBe('LOST');
    expect(f.updates[0]).toMatchObject({
      status: 'LOST',
      lostReason: 'too dear',
    });
  });

  it('leaving a closed stage for an OPEN one sets IN_PROGRESS and clears the reason', async () => {
    for (const status of ['WON', 'LOST']) {
      const f = fake(
        lead({ status, lostReason: status === 'LOST' ? 'x' : null }),
        {
          id: 'S1',
          pipelineId: 'P',
          kind: 'OPEN',
        },
      );
      const r = await moveLeadToStage(f.tx, input);
      expect(r.status).toBe('IN_PROGRESS');
      expect(f.updates[0]).toMatchObject({
        status: 'IN_PROGRESS',
        lostReason: null,
      });
    }
  });

  it('moves across pipelines', async () => {
    const f = fake(lead(), { id: 'S1', pipelineId: 'P2', kind: 'OPEN' });
    const r = await moveLeadToStage(f.tx, input);
    expect(r.pipelineId).toBe('P2');
    expect(f.updates[0]).toMatchObject({
      pipelineId: 'P2',
      pipelineStageId: 'S1',
    });
    expect(f.audits[0]!.safeInputSummary).toMatchObject({
      fromPipelineId: 'P',
      toPipelineId: 'P2',
    });
  });

  it('the agent is a SYSTEM actor with no actor id', async () => {
    const f = fake(lead(), { id: 'S1', pipelineId: 'P', kind: 'OPEN' });
    await moveLeadToStage(f.tx, {
      ...input,
      actor: 'AGENT',
      actorId: 'ignored',
    });
    expect(f.updates[0]).toMatchObject({ stageSetBy: 'AGENT' });
    expect(f.audits[0]).toMatchObject({ actorType: 'SYSTEM', actorId: null });
  });

  it('a move to the same OPEN stage is a no-op', async () => {
    const f = fake(lead({ pipelineStageId: 'S1' }), {
      id: 'S1',
      pipelineId: 'P',
      kind: 'OPEN',
    });
    expect((await moveLeadToStage(f.tx, input)).moved).toBe(false);
    expect(f.updates).toHaveLength(0);
    expect(f.audits).toHaveLength(0);
  });

  it('syncs a status that disagrees with the stage it already sits in', async () => {
    const f = fake(lead({ pipelineStageId: 'S1', status: 'IN_PROGRESS' }), {
      id: 'S1',
      pipelineId: 'P',
      kind: 'WON',
    });
    expect((await moveLeadToStage(f.tx, input)).status).toBe('WON');
  });

  it('an unknown lead or stage is NOT_FOUND', async () => {
    await expect(
      moveLeadToStage(
        fake(null, { id: 'S1', pipelineId: 'P', kind: 'OPEN' }).tx,
        input,
      ),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    await expect(
      moveLeadToStage(fake(lead(), null).tx, input),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });
});
