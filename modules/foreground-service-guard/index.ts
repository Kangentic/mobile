import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * The native stop alarm on notifee's dataSync foreground service (Sentry MOBILE-3), and the
 * stop-settle wait a keepalive start makes behind an earlier stop (Sentry MOBILE-J). See the
 * Kotlin ForegroundServiceGuard for why a JS bound alone is not enough for either.
 *
 * ANDROID ONLY. The service it guards exists only on Android, and elsewhere every call is a
 * no-op.
 *
 * `requireOptionalNativeModule` rather than `requireNativeModule`, as in
 * `modules/memory-pressure`: this module exists only in a build that ran prebuild with it
 * present, and vitest/Jest load this file with no native runtime at all.
 */
interface ForegroundServiceGuardNativeModule {
  armStopAlarm: (delayMs: number) => void;
  disarmStopAlarm: () => void;
  awaitServiceStopped: (timeoutMs: number) => Promise<boolean>;
}

const nativeModule =
  Platform.OS === 'android' ? requireOptionalNativeModule<ForegroundServiceGuardNativeModule>('ForegroundServiceGuard') : null;

/**
 * Arms, or re-arms, the one stop alarm `delayMs` from now on elapsed realtime. If it fires,
 * native code stops notifee's foreground service whether or not JS is running.
 *
 * Swallows a native failure. The alarm is a safety net under the keepalive, not a precondition
 * for it. A failed arm leaves the service bounded only by the JS ceiling, which is where it
 * stood before the net existed. Refusing the keepalive instead would make the net cost more
 * than its absence.
 */
export function armForegroundServiceStopAlarm(delayMs: number): void {
  try {
    nativeModule?.armStopAlarm(delayMs);
  } catch {
    // See above. Not reported: the only caller sits in src/notifications/, which
    // crash-reporting-scope.md bans from reporting to Sentry.
  }
}

/** Cancels the stop alarm, if armed. Safe to call when nothing is armed. */
export function disarmForegroundServiceStopAlarm(): void {
  try {
    nativeModule?.disarmStopAlarm();
  } catch {
    // A stale alarm that survives a failed cancel fires into a service that is already gone,
    // which only costs an occasional process start.
  }
}

/**
 * Resolves once notifee's service has no record in the system, meaning any STOP sent earlier has
 * actually run, or `false` if it is still there after `timeoutMs` (Sentry MOBILE-J; see the Kotlin
 * ForegroundServiceGuard for why a stop that was merely SENT is not enough).
 *
 * Resolves `true` where there is nothing to ask: off Android, and in a build without the module.
 * It also resolves `true` when the native call fails, and that is a choice rather than a default.
 * Before this wait existed nothing waited at all, so `true` puts a device whose query throws back
 * exactly where every device stood before, while `false` would withdraw the keepalive from it for
 * good. The same stance as the alarm above: a net under the keepalive, never a precondition for it.
 */
export async function awaitForegroundServiceStopped(timeoutMs: number): Promise<boolean> {
  if (!nativeModule) return true;
  try {
    return await nativeModule.awaitServiceStopped(timeoutMs);
  } catch {
    // See above. Not reported: the only caller sits in src/notifications/, which
    // crash-reporting-scope.md bans from reporting to Sentry.
    return true;
  }
}
