import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { PUSH_CATEGORIES, type PushCategory, type RegisterPushRequestPayload } from '@kangentic/protocol';
import { CapabilityError, type VerbClient } from '@/channel/verbClient';
import { useSettingsStore } from '@/state/settingsStore';
import {
  base64UrlEncode,
  getLastRegisteredExpoToken,
  getOrCreatePushKey,
  persistNsePushIdentityPublicKey,
  setLastRegisteredExpoToken,
} from './pushKeys';
import { getPushIdentityPublicKey } from './pushIdentity';

/**
 * Registers this device for E2E-encrypted remote push with the desktop:
 * the device-generated push key plus the Expo push token travel over the
 * established secure channel via the register-push verb. Called
 * fire-and-forget on every established bootstrap, and again
 * (registerPushAgainWithDesktop) when the desktop's project list says it
 * holds no registration for this phone (protocol 0.30.0); every failure mode
 * is non-fatal and recorded as a status the Settings UI reads.
 *
 * - 'unavailable-no-fcm': getExpoPushTokenAsync threw (an Android build
 *   without google-services.json, or offline). The app works fully;
 *   remote push is simply off.
 * - 'capability-denied': the desktop refused the verb (an older desktop
 *   without register-push, or the verb not granted). Also non-fatal.
 */

export type PushRegistrationStatus = 'registered' | 'unavailable-no-fcm' | 'capability-denied' | 'not-connected' | 'pending';

/** The one verb this module needs; injected by the connection manager so no import cycle forms. */
export type PushRegistrarVerbs = Pick<VerbClient, 'registerPush'>;

let registrationStatus: PushRegistrationStatus = 'pending';
let registeredThisProcess = false;
let lastRegisteredCategories: PushCategory[] | null = null;
/**
 * Registrations run one at a time, each after the one before it settles, so a
 * later one reads the state an earlier one left instead of racing it. That is
 * what lets registerPushAgainWithDesktop send exactly once when the
 * established-handshake registration is still in flight. The one exception is
 * a registration still pending after PREVIOUS_REGISTRATION_WAIT_CAP_MS: the
 * next one stops waiting for it. Never rejects: registerOnce catches
 * everything.
 */
let registrationQueue: Promise<void> = Promise.resolve();

/**
 * How long a registration waits for the one queued before it. Its register-push
 * has the capability client's request timeout, but the Expo token fetch has
 * none of its own (getExpoPushTokenAsync is a bare fetch), so one that never
 * settled would otherwise hold back every later registration for the rest of
 * the process, the bootstrap's repair included, where before the queue it held
 * back only itself. Past the cap the next one runs beside it, as every
 * registration did before the queue. A cap rather than a timeout on the fetch,
 * so a slow fetch that would have succeeded still does.
 */
const PREVIOUS_REGISTRATION_WAIT_CAP_MS = 30_000;

/**
 * Moves on at every unregister. A registration notes it when it is queued and,
 * once it has moved on, neither sends nor records anything. An unpair can land
 * while a registration waits in the queue or on its token fetch; without this,
 * that registration would then put the device back on the desktop it just
 * left, mint a push key after the unpair wiped it, and leave this process
 * marked registered, so a re-pair with the same desktop (no key change, so no
 * reset in connectionManager.ts) would skip its own registration. Deliberately
 * not moved by resetPushRegistrationProcessState: registerPushAgainWithDesktop
 * resets too, and must not cancel the established-handshake registration it
 * relies on.
 */
let unregisterGeneration = 0;

/** For the Settings UI (workstream B7). */
export function getPushRegistrationStatus(): PushRegistrationStatus {
  return registrationStatus;
}

/** The categories the user currently wants pushed, in PUSH_CATEGORIES order. */
function enabledCategories(): PushCategory[] {
  const enabledMap = useSettingsStore.getState().pushCategoriesEnabled;
  return PUSH_CATEGORIES.filter((category) => enabledMap[category] !== false);
}

function sameCategories(currentCategories: PushCategory[], registeredCategories: PushCategory[] | null): boolean {
  return (
    registeredCategories !== null &&
    currentCategories.length === registeredCategories.length &&
    currentCategories.every((category, index) => category === registeredCategories[index])
  );
}

function resolveEasProjectId(): string | undefined {
  const easConfigProjectId: unknown = Constants.easConfig?.projectId;
  if (typeof easConfigProjectId === 'string' && easConfigProjectId.length > 0) return easConfigProjectId;
  const extra: unknown = Constants.expoConfig?.extra;
  if (typeof extra !== 'object' || extra === null) return undefined;
  const eas: unknown = (extra as Record<string, unknown>).eas;
  if (typeof eas !== 'object' || eas === null) return undefined;
  const projectId: unknown = (eas as Record<string, unknown>).projectId;
  return typeof projectId === 'string' && projectId.length > 0 ? projectId : undefined;
}

/**
 * Idempotent registration: re-run on every established bootstrap, it only
 * hits the wire when this process has not registered yet or the Expo token
 * rotated since the last successful registration. Queued behind any
 * registration still in flight. Never throws.
 */
export function registerPushWithDesktop(verbs: PushRegistrarVerbs | null): Promise<void> {
  const unregisterGenerationAtQueue = unregisterGeneration;
  const registration = settledOrCapped(registrationQueue, PREVIOUS_REGISTRATION_WAIT_CAP_MS).then(() =>
    registerOnce(verbs, unregisterGenerationAtQueue),
  );
  registrationQueue = registration;
  return registration;
}

/** Resolves once `previous` settles or `capMs` passes, whichever is first. Never rejects. */
function settledOrCapped(previous: Promise<void>, capMs: number): Promise<void> {
  return new Promise((resolve) => {
    const capTimer = setTimeout(resolve, capMs);
    const onPreviousSettled = (): void => {
      clearTimeout(capTimer);
      resolve();
    };
    previous.then(onPreviousSettled, onPreviousSettled);
  });
}

/**
 * Registers again although this process already registered: the desktop's
 * project list said it holds no registration for this phone
 * (`pushRegistered: false`, protocol 0.30.0), for example after it set aside a
 * corrupt registrations file. Nothing is sent when the user turned
 * notifications off, which is also why a desktop holds none for them. Never
 * throws.
 *
 * The reset happens NOW, not when this registration's turn in the queue comes.
 * A registration already in flight that has not reached its idempotence check
 * yet (the established-handshake one, waiting on its Expo token) then sends,
 * and the registration queued here finds it done and sends nothing. One
 * already on the wire (a cold start's, past that check) registers first, and
 * this one again finds it done. One that already finished without sending
 * leaves this one to send. Either way the desktop is told once, unless the one
 * in flight is still pending past PREVIOUS_REGISTRATION_WAIT_CAP_MS, when both
 * may send and the second only repeats the first. Skipping instead while a
 * registration is in flight would send nothing at all on a reconnect, where
 * the in-flight one still believes this process is registered.
 */
export function registerPushAgainWithDesktop(verbs: PushRegistrarVerbs): Promise<void> {
  if (useSettingsStore.getState().backgroundNotificationsMode === 'off') return Promise.resolve();
  resetPushRegistrationProcessState();
  return registerPushWithDesktop(verbs);
}

async function registerOnce(verbs: PushRegistrarVerbs | null, unregisterGenerationAtQueue: number): Promise<void> {
  const unregisteredSinceQueued = (): boolean => unregisterGeneration !== unregisterGenerationAtQueue;
  try {
    if (!verbs) {
      registrationStatus = 'not-connected';
      return;
    }

    let expoPushToken: string;
    try {
      const projectId = resolveEasProjectId();
      const token = await Notifications.getExpoPushTokenAsync(projectId !== undefined ? { projectId } : {});
      expoPushToken = token.data;
    } catch {
      // On Android without google-services.json this throws; treat remote
      // push as unavailable and keep booting.
      registrationStatus = 'unavailable-no-fcm';
      return;
    }

    const categories = enabledCategories();
    const lastRegisteredToken = await getLastRegisteredExpoToken();
    if (
      registeredThisProcess &&
      registrationStatus === 'registered' &&
      lastRegisteredToken === expoPushToken &&
      sameCategories(categories, lastRegisteredCategories)
    ) {
      return;
    }

    // Before the key read, so an unregister during the token fetch cannot be
    // followed by a key minted after the unpair's wipe.
    if (unregisteredSinceQueued()) return;
    const pushKey = await getOrCreatePushKey();
    const payload: RegisterPushRequestPayload = {
      action: 'register',
      expoPushToken,
      pushKeyBase64: base64UrlEncode(pushKey),
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      categories,
      // Sealed clears (protocol 0.23.0). Both platforms handle them in this
      // build: Android's receive task removes what a clear names and displays
      // nothing, iOS applies a standalone clear in the same task (background
      // mode) and a piggybacked one in the Notification Service Extension. A
      // build that did not would render a clear as the placeholder, which is
      // why the desktop sends none to a registration without this flag.
      acceptsClears: true,
    };

    // Again across the key read. registerPush writes its frame synchronously,
    // so a register that passes this check reaches the desktop ahead of any
    // later unregister, which then has the last word.
    if (unregisteredSinceQueued()) return;
    try {
      const response = await verbs.registerPush(payload);
      // The unregister went out after this register: record nothing, so a
      // re-pair in this process registers afresh.
      if (unregisteredSinceQueued()) return;
      if (response.registered) {
        registrationStatus = 'registered';
        registeredThisProcess = true;
        lastRegisteredCategories = categories;
        await setLastRegisteredExpoToken(expoPushToken);
        // Hand the iOS Notification Service Extension the AAD it cannot derive
        // for itself, pinned to the identity this registration actually used.
        // No-op off iOS. Done here rather than earlier so the stored public key
        // and the registered token always describe the same live registration.
        const identityPublicKey = await getPushIdentityPublicKey();
        if (identityPublicKey) await persistNsePushIdentityPublicKey(identityPublicKey);
      } else {
        registrationStatus = 'capability-denied';
      }
    } catch (error) {
      // An old desktop (no register-push verb) or a revoked grant answers
      // with a CapabilityError; anything else is a transport-level failure.
      registrationStatus = error instanceof CapabilityError ? 'capability-denied' : 'not-connected';
    }
  } catch {
    // A SecureStore failure loading/persisting the key or token cache:
    // stay at the current status; the next established bootstrap retries.
  }
}

/**
 * Drops the process-local idempotence bookkeeping without sending anything.
 * The cache above is process-global, not per-desktop, so the connection
 * manager calls this when the persisted anchor's desktop key changes within
 * one process (a re-pair that never went through the unpair flow) - without
 * it, the previous desktop's "already registered" state would suppress
 * registration with the new one until the next app restart.
 */
export function resetPushRegistrationProcessState(): void {
  registrationStatus = 'pending';
  registeredThisProcess = false;
  lastRegisteredCategories = null;
}

/**
 * Best-effort unregister, sent while the channel is still up (before the
 * unpair flow tears down the connection). Always resets local state so a
 * re-pair in the same process registers fresh rather than short-circuiting
 * on stale "already registered" bookkeeping. Never throws - the local key
 * wipe (pushKeys.clearPushRegistration) is what actually matters for this
 * device; if the unregister message never lands, the desktop's own
 * DeviceNotRegistered handling or roster revocation cleans it up.
 */
export async function unregisterPushWithDesktop(verbs: PushRegistrarVerbs | null): Promise<void> {
  // First, before anything can await: every registration queued until now is
  // cancelled (see unregisterGeneration).
  unregisterGeneration += 1;
  resetPushRegistrationProcessState();
  if (!verbs) return;
  try {
    await verbs.registerPush({ action: 'unregister' });
  } catch {
    // Best-effort; see the doc comment above.
  }
}
