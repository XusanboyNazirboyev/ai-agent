import { describe, expect, it } from 'vitest';
import { blockingOutsiders, deletionOrder } from './tenant-erasure.js';

describe('tenant erasure order', () => {
  it('deletes children before the parents they block', () => {
    const order = deletionOrder(
      ['leads', 'conversations', 'messages', 'contacts'],
      [
        { child: 'messages', parent: 'conversations', action: 'r' },
        { child: 'conversations', parent: 'contacts', action: 'a' },
        { child: 'leads', parent: 'contacts', action: 'r' },
      ],
    );
    expect(order.indexOf('messages')).toBeLessThan(
      order.indexOf('conversations'),
    );
    expect(order.indexOf('conversations')).toBeLessThan(
      order.indexOf('contacts'),
    );
    expect(order.indexOf('leads')).toBeLessThan(order.indexOf('contacts'));
    expect(order).toHaveLength(4);
  });

  it('ignores cascading keys and a table referencing itself', () => {
    expect(
      deletionOrder(
        ['a', 'b', 'persons'],
        [
          { child: 'a', parent: 'b', action: 'c' },
          { child: 'b', parent: 'a', action: 'n' },
          { child: 'persons', parent: 'persons', action: 'r' },
        ],
      ),
    ).toEqual(['a', 'b', 'persons']);
  });

  it('refuses a blocking cycle between two tables before deleting', () => {
    expect(() =>
      deletionOrder(
        ['a', 'b'],
        [
          { child: 'a', parent: 'b', action: 'r' },
          { child: 'b', parent: 'a', action: 'r' },
        ],
      ),
    ).toThrow(/cycle among a, b/u);
  });

  it('reports a table without tenant_id that blocks tenant rows', () => {
    expect(
      blockingOutsiders(
        ['contacts'],
        [
          { child: 'contacts', parent: 'tenants', action: 'c' },
          { child: 'exports', parent: 'contacts', action: 'r' },
          { child: 'plans_log', parent: 'tenants', action: 'n' },
          { child: 'platform_audit_events', parent: 'tenants', action: 'n' },
        ],
      ),
    ).toEqual(['exports -> contacts']);
  });
});
