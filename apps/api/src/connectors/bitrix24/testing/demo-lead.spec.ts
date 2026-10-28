import { describe, expect, it, vi } from 'vitest';
import { findDemoLead } from './demo-lead.js';

describe('findDemoLead (Bitrix24 demo)', () => {
  it('looks only at the tenant the demo created', async () => {
    const findFirst = vi.fn(async () => ({
      id: 'lead-1',
      tenantId: 'tenant-demo',
      contactId: 'contact-1',
    }));
    const db = { lead: { findFirst } } as never;
    await expect(findDemoLead(db, 'tenant-demo')).resolves.toMatchObject({
      id: 'lead-1',
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-demo' } }),
    );
  });

  it('finds nothing without a tenant instead of taking the newest lead anywhere', async () => {
    const findFirst = vi.fn();
    await expect(
      findDemoLead({ lead: { findFirst } } as never, undefined),
    ).resolves.toBeUndefined();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
