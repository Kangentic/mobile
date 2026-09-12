import notifee, { type DisplayedNotification } from '@notifee/react-native';
import { hexToBytes } from '@kangentic/protocol';
import { requestNotificationPermission } from '@/notifications';
import { seedSharedPushKeysForProbe } from '@/notifications/pushKeys';
import { NSE_PROBE_IDENTITY_PUBLIC_KEY_HEX, NSE_PROBE_PUSH_KEY_HEX, nseProbeEnabled } from './nseProbeVectors';

/**
 * The two Settings actions the NSE probe drives (see nseProbeVectors.ts for
 * what the probe is and why). Lives in devsupport, beside the retention probe:
 * a flag-gated diagnostic that ships inert, may reach the notification and
 * push-key modules, and has nothing to do with crash reporting or the router.
 */

export { nseProbeEnabled };

export interface NseProbeSeedOutcome {
  permissionGranted: boolean;
}

/**
 * Seeds the known vectors into the shared Keychain through the production
 * write path, then asks for notification permission, without which iOS drops
 * an alert push before any extension runs. Throws when there is no shared
 * group: the Settings row shows the message, which is how an entitlement
 * error becomes readable on the runner's failure screenshot instead of
 * looking like a decrypt failure.
 */
export async function seedNseProbe(): Promise<NseProbeSeedOutcome> {
  await seedSharedPushKeysForProbe(hexToBytes(NSE_PROBE_PUSH_KEY_HEX), hexToBytes(NSE_PROBE_IDENTITY_PUBLIC_KEY_HEX));
  const permissionGranted = await requestNotificationPermission();
  return { permissionGranted };
}

/**
 * What the OS actually displayed for the most recent notification: the
 * extension's title and body if it decrypted, the placeholder if it did not,
 * nothing if the push never rendered. Nothing in the app clears delivered
 * notifications, so this reads the extension-modified content back
 * mechanically rather than from a screenshot. The probe's own content only;
 * a real user's notification never reaches this path because the probe is
 * inert in every shipped build.
 */
export async function readNseProbeResult(): Promise<string> {
  const displayed = await notifee.getDisplayedNotifications();
  const newest = newestDisplayed(displayed);
  if (newest === undefined) return 'no notification delivered';
  const title = newest.notification.title ?? '(no title)';
  const body = newest.notification.body ?? '(no body)';
  return `${title} | ${body}`;
}

/**
 * notifee promises nothing about the order of the list, so the newest entry
 * is the greatest `date`, with list order as the tie-break (a stable sort
 * keeps undated entries where the OS put them). The field is typed as a
 * string but the iOS bridge sends epoch milliseconds as a number
 * (NotifeeCoreUtil convertToTimestamp), so both are accepted.
 */
function newestDisplayed(displayed: readonly DisplayedNotification[]): DisplayedNotification | undefined {
  const ordered = [...displayed].sort((first, second) => {
    const firstAt = displayedAtMs(first);
    const secondAt = displayedAtMs(second);
    if (firstAt === secondAt) return 0;
    return firstAt < secondAt ? -1 : 1;
  });
  return ordered[ordered.length - 1];
}

function displayedAtMs(entry: DisplayedNotification): number {
  const raw: unknown = entry.date;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}
