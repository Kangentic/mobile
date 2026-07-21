/**
 * Android channel definitions: created exactly once per boot, with the
 * importance levels the categories demand, and the category-to-channel
 * mapping the decrypt and local-notify paths share.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AndroidChannel } from '@notifee/react-native';

const notifeeState = vi.hoisted(() => ({
  createChannels: vi.fn(async (_channels: unknown) => undefined),
  requestPermission: vi.fn(async () => ({ authorizationStatus: 1 })),
}));

vi.mock('@notifee/react-native', () => ({
  default: {
    createChannels: notifeeState.createChannels,
    requestPermission: notifeeState.requestPermission,
  },
  AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 },
  AuthorizationStatus: { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 },
}));

type ChannelsModule = typeof import('@/notifications/channels');

async function loadChannels(): Promise<ChannelsModule> {
  return import('@/notifications/channels');
}

describe('notification channels', () => {
  beforeEach(() => {
    vi.resetModules();
    notifeeState.createChannels.mockClear();
    notifeeState.requestPermission.mockReset();
  });

  it('creates the five channels once, with the right importance levels', async () => {
    const channels = await loadChannels();
    await channels.createNotificationChannels();
    await channels.createNotificationChannels();

    expect(notifeeState.createChannels).toHaveBeenCalledTimes(1);
    const createdChannels = notifeeState.createChannels.mock.calls[0][0] as AndroidChannel[];
    const importanceById = Object.fromEntries(createdChannels.map((channel) => [channel.id, channel.importance]));
    expect(importanceById).toEqual({
      'needs-attention': 4,
      completions: 3,
      failures: 4,
      stalls: 3,
      connection: 2,
    });
  });

  it('maps push categories onto the channels', async () => {
    const channels = await loadChannels();
    expect(channels.channelIdForCategory('input-required')).toBe('needs-attention');
    expect(channels.channelIdForCategory('turn-complete')).toBe('completions');
    expect(channels.channelIdForCategory('session-failed')).toBe('failures');
    expect(channels.channelIdForCategory('plan-complete')).toBe('completions');
    expect(channels.channelIdForCategory('spawn-stalled')).toBe('stalls');
  });

  it('titleForCategory names each category, shared with the local notifier', async () => {
    const channels = await loadChannels();
    expect(channels.titleForCategory('input-required')).toBe('Agent needs your input');
    expect(channels.titleForCategory('turn-complete')).toBe('Turn complete');
    expect(channels.titleForCategory('session-failed')).toBe('Session stopped');
    expect(channels.titleForCategory('plan-complete')).toBe('Plan complete');
    expect(channels.titleForCategory('spawn-stalled')).toBe('Still preparing');
  });

  it('requestNotificationPermission maps the notifee authorization status to a boolean', async () => {
    const channels = await loadChannels();
    notifeeState.requestPermission.mockResolvedValue({ authorizationStatus: 1 });
    expect(await channels.requestNotificationPermission()).toBe(true);
    notifeeState.requestPermission.mockResolvedValue({ authorizationStatus: 0 });
    expect(await channels.requestNotificationPermission()).toBe(false);
  });
});
