import { describe, expect, it } from 'vitest';
import { PLATFORM_NAME } from '@agentcore/shared';

describe('workspace shared package', () => {
  it('resolves the shared export through the pnpm workspace package', () => {
    expect(PLATFORM_NAME).toBe('AgentCore');
  });
});
