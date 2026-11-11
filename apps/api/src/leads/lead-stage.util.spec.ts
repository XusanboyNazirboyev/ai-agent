import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LEAD_STAGES, ensureLeadStages } from './lead-stage.util.js';

describe('lead-stage.util', () => {
  it('defines default stages in order', () => {
    expect(DEFAULT_LEAD_STAGES.map((s) => s.code)).toEqual([
      'NEW',
      'HOT',
      'WARM',
      'COLD',
    ]);
    expect(DEFAULT_LEAD_STAGES.map((s) => s.position)).toEqual([0, 1, 2, 3]);
  });

  it('creates defaults (skip duplicates) and returns NEW stage id', async () => {
    const tx = {
      leadStage: {
        createMany: vi.fn().mockResolvedValue({ count: 4 }),
        findUnique: vi.fn().mockResolvedValue({ id: 'stage-new' }),
      },
    };
    const id = await ensureLeadStages(
      tx as unknown as Parameters<typeof ensureLeadStages>[0],
      'tenant-1',
    );
    expect(tx.leadStage.createMany).toHaveBeenCalledWith({
      data: DEFAULT_LEAD_STAGES.map(({ code, position }) => ({
        tenantId: 'tenant-1',
        code,
        position,
      })),
      skipDuplicates: true,
    });
    expect(tx.leadStage.findUnique).toHaveBeenCalledWith({
      where: { tenantId_code: { tenantId: 'tenant-1', code: 'NEW' } },
      select: { id: true },
    });
    expect(id).toBe('stage-new');
  });

  it('throws when NEW stage cannot be found after creation', async () => {
    const tx = {
      leadStage: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    await expect(
      ensureLeadStages(
        tx as unknown as Parameters<typeof ensureLeadStages>[0],
        't',
      ),
    ).rejects.toThrow('Default lead stage creation failed');
  });
});
