import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import type { RegisterPushRequestPayload } from '@kangentic/protocol';
import { CapabilityError, type VerbClient } from '@/channel/verbClient';
import { base64UrlEncode, getLastRegisteredExpoToken, getOrCreatePushKey, setLastRegisteredExpoToken } from './pushKeys';

/**
 * Registers this device for E2E-encrypted remote push with the desktop:
 * the device-generated push key plus the Expo push token travel over the
 * established secure channel via the register-push verb. Called
 * fire-and-forget on every established bootstrap; every failure mode is
 * non-fatal and recorded as a status the Settings UI reads.
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

/** For the Settings UI (workstream B7). */
export function getPushRegistrationStatus(): PushRegistrationStatus {
  return registrationStatus;
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
 * rotated since the last successful registration. Never throws.
 */
export async function registerPushWithDesktop(verbs: PushRegistrarVerbs | null): Promise<void> {
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

    const lastRegisteredToken = await getLastRegisteredExpoToken();
    if (registeredThisProcess && registrationStatus === 'registered' && lastRegisteredToken === expoPushToken) return;

    const pushKey = await getOrCreatePushKey();
    const payload: RegisterPushRequestPayload = {
      action: 'register',
      expoPushToken,
      pushKeyBase64: base64UrlEncode(pushKey),
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
    };

    try {
      const response = await verbs.registerPush(payload);
      if (response.registered) {
        registrationStatus = 'registered';
        registeredThisProcess = true;
        await setLastRegisteredExpoToken(expoPushToken);
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
