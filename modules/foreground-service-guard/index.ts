import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * The native stop alarm on notifee's dataSync foreground service (Sentry MOBILE-3). See the
 * Kotlin ForegroundServiceGuard for why a JS bound alone is not enough.
 *
 * ANDROID ONLY. The service it guards exists only on Android, and elsewhere both calls are
 * no-ops.
 *
 * `requireOptionalNativeModule` rather than `requireNativeModule`, as in
 * `modules/memory-pressure`: this module exists only in a build that ran prebuild with it
 * present, and vitest/Jest load this file with no native runtime at all.
 */
interface ForegroundServiceGuardNativeModule {
  armStopAlarm: (delayMs: number) => void;
  disarmStopAlarm: () => void;
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
