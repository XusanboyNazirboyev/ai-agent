import { describe, expect, it, vi } from 'vitest';
import { channelSlotFree } from './channel-limit.js';

function db(
  subscription: unknown,
  active: number,
): {
  tenantSubscription: { findFirst: ReturnType<typeof vi.fn> };
  channelAccount: { count: ReturnType<typeof vi.fn> };
} {
  return {
    tenantSubscription: { findFirst: vi.fn().mockResolvedValue(subscription) },
    channelAccount: { count: vi.fn().mockResolvedValue(active) },
  };
}

describe('channelSlotFree', () => {
  it('includes exactly one channel without a subscription', async () => {
    const first = db(null, 0);
    const second = db(null, 1);
    await expect(
      channelSlotFree(first as never, 'tenant', 'new'),
    ).resolves.toBe(true);
    await expect(
      channelSlotFree(second as never, 'tenant', 'new'),
    ).resolves.toBe(false);
  });

  it('keeps trials at one and lets a paid plan explicitly grant more', async () => {
    const trial = db(
      { status: 'TRIAL', plan: { limits: { maxChannelAccounts: 5 } } },
      1,
    );
    const paid = db(
      { status: 'ACTIVE', plan: { limits: { maxChannelAccounts: 2 } } },
      1,
    );
    await expect(
      channelSlotFree(trial as never, 'tenant', 'new'),
    ).resolves.toBe(false);
    await expect(channelSlotFree(paid as never, 'tenant', 'new')).resolves.toBe(
      true,
    );
    expect(paid.channelAccount.count).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant',
        status: 'ACTIVE',
        id: { not: 'new' },
        channelType: { not: 'manual' },
      },
    });
  });
});
