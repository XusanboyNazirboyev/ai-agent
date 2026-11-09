import { describe, expect, it } from 'vitest';
import { channelName } from './channel-names';

describe('channelName', () => {
  it('names the connected channels properly', () => {
    expect(channelName('telegram')).toBe('Telegram');
    expect(channelName('instagram')).toBe('Instagram');
    expect(channelName('facebook')).toBe('Messenger');
  });

  it('falls back to the raw type for an unknown channel', () => {
    expect(channelName('signal')).toBe('signal');
  });
});
