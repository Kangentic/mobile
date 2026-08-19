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
  getNotificationSettings: vi.fn(async () => ({ authorizationStatus: 1 })),
  openNotificationSettings: vi.fn(async () => undefined),
}));

vi.mock('@notifee/react-native', () => ({
  default: {
    createChannels: notifeeState.createChannels,
    requestPermission: notifeeState.requestPermission,
    getNotificationSettings: notifeeState.getNotificationSettings,
    openNotificationSettings: notifeeState.openNotificationSettings,
  },
  AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 },
  AuthorizationStatus: { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 },
}));

type ChannelsModule = typeof import('@/notifications/channels');
type PermissionCacheModule = typeof import('@/notifications/permissionCache');

async function loadChannels(): Promise<ChannelsModule> {
  return import('@/notifications/channels');
}

/**
 * Must be loaded through the same resetModules generation as channels.ts, or
 * the cache read here is a different module instance from the one written to.
 */
async function loadPermissionCache(): Promise<PermissionCacheModule> {
  return import('@/notifications/permissionCache');
}

describe('notification channels', () => {
  beforeEach(() => {
    vi.resetModules();
    notifeeState.createChannels.mockClear();
    notifeeState.requestPermission.mockReset();
    notifeeState.getNotificationSettings.mockReset();
    notifeeState.openNotificationSettings.mockClear();
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
    // Not "Turn complete" any more: both producers settle-debounce this, so it
    // marks a session going quiet rather than each turn ending.
    expect(channels.titleForCategory('turn-complete')).toBe('Agent went idle');
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
    // PROVISIONAL is iOS-only but channels.ts accepts it, so pin it rather
    // than leave the third branch of statusFromAuthorization uncovered.
    notifeeState.requestPermission.mockResolvedValue({ authorizationStatus: 2 });
    expect(await channels.requestNotificationPermission()).toBe(true);
  });

  /**
   * The cache is what the background-keepalive gate reads, and it must be read
   * SYNCHRONOUSLY: an awaited permission check in front of the foreground
   * service start is what causes ForegroundServiceDidNotStartInTimeException.
   */
  it('starts unknown, then records what the OS reported', async () => {
    const channels = await loadChannels();
    const cache = await loadPermissionCache();

    // null, not false: nothing has looked yet, and the gate must not read an
    // unread cache as a denial.
    expect(cache.notificationPermissionGranted()).toBeNull();

    notifeeState.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 });
    expect(await channels.refreshNotificationPermission()).toBe(false);
    expect(cache.notificationPermissionGranted()).toBe(false);

    notifeeState.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 });
    await channels.refreshNotificationPermission();
    expect(cache.notificationPermissionGranted()).toBe(true);
  });

  /**
   * The only recovery path once Android has stopped showing the runtime
   * prompt (after two dismissals): Settings must be able to hand the user
   * off to the OS notification settings screen for this app.
   */
  it('openSystemNotificationSettings opens the OS settings screen for this app', async () => {
    const channels = await loadChannels();

    await channels.openSystemNotificationSettings();

    expect(notifeeState.openNotificationSettings).toHaveBeenCalledTimes(1);
  });

  it('a granted request updates the cache too, not just the refresh path', async () => {
    const channels = await loadChannels();
    const cache = await loadPermissionCache();

    notifeeState.requestPermission.mockResolvedValue({ authorizationStatus: 0 });
    await channels.requestNotificationPermission();
    expect(cache.notificationPermissionGranted()).toBe(false);

    notifeeState.requestPermission.mockResolvedValue({ authorizationStatus: 1 });
    await channels.requestNotificationPermission();
    expect(cache.notificationPermissionGranted()).toBe(true);
  });

  /**
   * NOT_DETERMINED has to survive as its own state rather than collapsing into
   * denied. It is iOS-only (Android reports plain DENIED for a permission
   * nobody has requested), and two callers depend on telling them apart: the
   * prompt gate, which asks again when the OS says nobody has been asked even
   * though the persisted flag survived a reinstall, and the Settings notice,
   * which must not tell a fresh iOS user they are blocked.
   */
  it('distinguishes not-determined from denied, while both read back as not-granted', async () => {
    const channels = await loadChannels();
    const cache = await loadPermissionCache();

    notifeeState.getNotificationSettings.mockResolvedValue({ authorizationStatus: -1 });
    expect(await channels.refreshNotificationPermission()).toBe(false);
    expect(cache.notificationPermissionStatus()).toBe('not-determined');
    expect(cache.notificationPermissionGranted()).toBe(false);

    notifeeState.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 });
    await channels.refreshNotificationPermission();
    expect(cache.notificationPermissionStatus()).toBe('denied');

    // PROVISIONAL (iOS quiet delivery) is granted: notifications do arrive.
    notifeeState.getNotificationSettings.mockResolvedValue({ authorizationStatus: 2 });
    await channels.refreshNotificationPermission();
    expect(cache.notificationPermissionStatus()).toBe('granted');
  });
});
