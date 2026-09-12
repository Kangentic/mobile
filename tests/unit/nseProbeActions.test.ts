/**
 * The two Settings actions the NSE probe drives (src/devsupport/nseProbe.ts):
 * seeding through the production write path and reading back what the OS
 * displayed. tests/unit/nseProbe.test.ts pins the vectors and the seal script;
 * this file pins the composition around them, which the SettingsScreen tests
 * mock away wholesale.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hexToBytes } from '@kangentic/protocol';
import type { DisplayedNotification } from '@notifee/react-native';
import { NSE_PROBE_IDENTITY_PUBLIC_KEY_HEX, NSE_PROBE_PUSH_KEY_HEX } from '@/devsupport/nseProbeVectors';
// vi.mock is hoisted above every import, so the module under test sees the
// mocks below even though the import sits here.
import { readNseProbeResult, seedNseProbe } from '@/devsupport/nseProbe';

const notifeeState = vi.hoisted(() => ({
  getDisplayedNotifications: vi.fn<() => Promise<DisplayedNotification[]>>(async () => []),
}));

const notificationsState = vi.hoisted(() => ({
  requestNotificationPermission: vi.fn<() => Promise<boolean>>(async () => true),
  seedSharedPushKeysForProbe: vi.fn<(pushKey: Uint8Array, identityPublicKey: Uint8Array) => Promise<void>>(
    async () => undefined,
  ),
  callOrder: [] as string[],
}));

vi.mock('@notifee/react-native', () => ({
  default: { getDisplayedNotifications: notifeeState.getDisplayedNotifications },
}));

vi.mock('@/notifications', () => ({
  requestNotificationPermission: notificationsState.requestNotificationPermission,
}));

vi.mock('@/notifications/pushKeys', () => ({
  seedSharedPushKeysForProbe: notificationsState.seedSharedPushKeysForProbe,
}));

/** A displayed entry shaped like notifee's; `date` is left to each test. */
function displayed(title: string | undefined, body: string | undefined, date?: string | number): DisplayedNotification {
  // notifee types `date` as a string, but its iOS bridge sends epoch
  // milliseconds as a number (NotifeeCoreUtil convertToTimestamp), so the
  // fixture is allowed to carry either.
  return { id: `${title ?? 'untitled'}-${date ?? 'undated'}`, date: date as string | undefined, notification: { title, body }, trigger: undefined as never };
}

beforeEach(() => {
  notifeeState.getDisplayedNotifications.mockReset();
  notifeeState.getDisplayedNotifications.mockResolvedValue([]);
  notificationsState.requestNotificationPermission.mockReset();
  notificationsState.requestNotificationPermission.mockImplementation(async () => {
    notificationsState.callOrder.push('permission');
    return true;
  });
  notificationsState.seedSharedPushKeysForProbe.mockReset();
  notificationsState.seedSharedPushKeysForProbe.mockImplementation(async () => {
    notificationsState.callOrder.push('seed');
  });
  notificationsState.callOrder = [];
});

describe('seedNseProbe', () => {
  it('seeds the probe vectors as bytes through the production write path, then asks for permission', async () => {
    const outcome = await seedNseProbe();

    expect(notificationsState.seedSharedPushKeysForProbe).toHaveBeenCalledTimes(1);
    const [pushKey, identityPublicKey] = notificationsState.seedSharedPushKeysForProbe.mock.calls[0];
    expect(pushKey).toEqual(hexToBytes(NSE_PROBE_PUSH_KEY_HEX));
    expect(identityPublicKey).toEqual(hexToBytes(NSE_PROBE_IDENTITY_PUBLIC_KEY_HEX));
    // Permission after the seed: an alert push with no key seeded yet would
    // render the placeholder and read like a decrypt failure.
    expect(notificationsState.callOrder).toEqual(['seed', 'permission']);
    expect(outcome).toEqual({ permissionGranted: true });
  });

  it('reports a refused permission rather than hiding it', async () => {
    notificationsState.requestNotificationPermission.mockResolvedValue(false);

    await expect(seedNseProbe()).resolves.toEqual({ permissionGranted: false });
  });

  it('lets a seed failure propagate, so the Settings row can show the reason', async () => {
    notificationsState.seedSharedPushKeysForProbe.mockRejectedValue(new Error('A required entitlement is not present'));

    await expect(seedNseProbe()).rejects.toThrow('A required entitlement is not present');
    expect(notificationsState.requestNotificationPermission).not.toHaveBeenCalled();
  });
});

describe('readNseProbeResult', () => {
  it('says so when nothing was delivered', async () => {
    await expect(readNseProbeResult()).resolves.toBe('no notification delivered');
  });

  it('joins the displayed title and body, which is what the read flow asserts on', async () => {
    notifeeState.getDisplayedNotifications.mockResolvedValue([
      displayed('Agent needs your input', 'NSE probe - decrypted on device', 1_700_000_000_000),
    ]);

    await expect(readNseProbeResult()).resolves.toBe('Agent needs your input | NSE probe - decrypted on device');
  });

  it('picks the most recently displayed notification by date, whatever order the OS lists them in', async () => {
    // notifee promises no ordering; iOS hands back epoch milliseconds.
    notifeeState.getDisplayedNotifications.mockResolvedValue([
      displayed('Agent needs your input', 'NSE probe - decrypted on device', 1_700_000_005_000),
      displayed('Kangentic', 'Agent needs attention', 1_700_000_000_000),
    ]);

    await expect(readNseProbeResult()).resolves.toBe('Agent needs your input | NSE probe - decrypted on device');
  });

  it('accepts an ISO date string too, since that is what the type declares', async () => {
    notifeeState.getDisplayedNotifications.mockResolvedValue([
      displayed('Agent needs your input', 'NSE probe - decrypted on device', '2026-09-12T20:00:05.000Z'),
      displayed('Kangentic', 'Agent needs attention', '2026-09-12T20:00:00.000Z'),
    ]);

    await expect(readNseProbeResult()).resolves.toBe('Agent needs your input | NSE probe - decrypted on device');
  });

  it('falls back to list order when no entry carries a date', async () => {
    notifeeState.getDisplayedNotifications.mockResolvedValue([
      displayed('Kangentic', 'Agent needs attention'),
      displayed('Agent needs your input', 'NSE probe - decrypted on device'),
    ]);

    await expect(readNseProbeResult()).resolves.toBe('Agent needs your input | NSE probe - decrypted on device');
  });

  it('names a missing title or body instead of printing undefined', async () => {
    notifeeState.getDisplayedNotifications.mockResolvedValue([displayed(undefined, undefined, 1_700_000_000_000)]);

    await expect(readNseProbeResult()).resolves.toBe('(no title) | (no body)');
  });
});
