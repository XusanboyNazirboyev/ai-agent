import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  awaitingTenant,
  currentTenant,
  runWithoutTenant,
  runWithTenant,
  runWithTenantSlot,
  setTenant,
  TenantContextError,
} from './tenant-context.js';

describe('tenant context (RLS plan S1)', () => {
  it('carries one tenant through async work and never switches it', async () => {
    const a = randomUUID();
    expect(currentTenant()).toBeNull();
    const seen = await runWithTenant(a, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentTenant();
    });
    expect(seen).toBe(a);
    expect(() =>
      runWithTenant(a, () => runWithTenant(randomUUID(), () => 1)),
    ).toThrow(TenantContextError);
    expect(
      runWithTenant(a, () => runWithTenant(a.toUpperCase(), currentTenant)),
    ).toBe(a);
    expect(() => runWithTenant('not-a-uuid', () => 1)).toThrow(
      TenantContextError,
    );
  });

  it('fills an empty slot once (the request shape) and ignores no slot', () => {
    const a = randomUUID();
    runWithTenantSlot(() => {
      expect(currentTenant()).toBeNull();
      setTenant(a);
      expect(currentTenant()).toBe(a);
      setTenant(a);
      expect(() => setTenant(randomUUID())).toThrow(TenantContextError);
    });
    expect(() => setTenant(a)).not.toThrow();
    expect(currentTenant()).toBeNull();
  });

  it('tells a request still waiting for its tenant from everything else (S5)', async () => {
    expect(awaitingTenant()).toBe(false);
    await runWithTenantSlot(async () => {
      expect(awaitingTenant()).toBe(true);
      await runWithTenant(randomUUID(), () =>
        expect(awaitingTenant()).toBe(false),
      );
      setTenant(randomUUID());
      expect(awaitingTenant()).toBe(false);
    });
    runWithTenantSlot(() =>
      runWithoutTenant(() => expect(awaitingTenant()).toBe(false)),
    );
  });

  it('leaves the context for shared work', () => {
    runWithTenant(randomUUID(), () => {
      expect(runWithoutTenant(currentTenant)).toBeNull();
    });
  });

  it('starts a lazy thenable inside the context', async () => {
    const a = randomUUID();
    let ranFor: string | null = 'never';
    const lazy = {
      then(resolve: (value: string | null) => void): void {
        ranFor = currentTenant();
        resolve(ranFor);
      },
    };
    const result = runWithTenant(a, () => lazy);
    await result;
    expect(ranFor).toBe(a);
  });
});
