/**
 * The native stop alarm on notifee's dataSync foreground service
 * (modules/foreground-service-guard, Sentry MOBILE-3 on 0.8.0+13).
 *
 * Two halves. The JS wrapper is tested by behaviour. The Kotlin cannot be loaded
 * by any JS tier, so the decisions that would fail SILENTLY on a device are
 * pinned as source text instead, the same way secureStoreKeychainLayout.test.ts
 * guards the Swift extension:
 * - a stop that resets notifee's static state by itself (a bare stopService
 *   leaves it for JS to clear, and a start landing first would crash in
 *   startForeground);
 * - an alarm that needs no exact-alarm permission;
 * - a receiver nothing outside the app can fire;
 * - names that still match across the TS, Kotlin, manifest and plugin.
 * The device run in the developer guide proves the alarm actually stops the
 * service.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTIFEE_FOREGROUND_SERVICE } from '../../plugins/withAndroidPushService';

const platformMock = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));
vi.mock('react-native', () => ({ Platform: platformMock }));

const nativeModuleState = vi.hoisted(() => ({
  module: null as null | { armStopAlarm: (delayMs: number) => void; disarmStopAlarm: () => void },
  requestedNames: [] as string[],
}));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: (name: string) => {
    nativeModuleState.requestedNames.push(name);
    return nativeModuleState.module;
  },
}));

async function loadGuard(): Promise<typeof import('../../modules/foreground-service-guard')> {
  vi.resetModules();
  return import('../../modules/foreground-service-guard');
}

const moduleRoot = join(__dirname, '..', '..', 'modules', 'foreground-service-guard');
const kotlinRoot = join(moduleRoot, 'android', 'src', 'main', 'java', 'expo', 'modules', 'foregroundserviceguard');

function readModuleFile(...segments: string[]): string {
  return readFileSync(join(...segments), 'utf8');
}

/** Source with comment lines removed, so a prose mention cannot satisfy an assertion. */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

describe('foreground-service-guard JS wrapper', () => {
  beforeEach(() => {
    platformMock.OS = 'android';
    nativeModuleState.module = null;
    nativeModuleState.requestedNames = [];
  });

  // The delays in this block are arbitrary on purpose: the wrapper forwards
  // whatever it is given. The production deadline is pinned in
  // foregroundService.test.ts, not here.
  it('forwards the arm delay and the disarm to the native module on Android', async () => {
    const armStopAlarm = vi.fn<(delayMs: number) => void>();
    const disarmStopAlarm = vi.fn<() => void>();
    nativeModuleState.module = { armStopAlarm, disarmStopAlarm };
    const guard = await loadGuard();

    guard.armForegroundServiceStopAlarm(123_456);
    guard.disarmForegroundServiceStopAlarm();

    expect(nativeModuleState.requestedNames).toEqual(['ForegroundServiceGuard']);
    expect(armStopAlarm).toHaveBeenCalledWith(123_456);
    expect(disarmStopAlarm).toHaveBeenCalledTimes(1);
  });

  /**
   * The alarm is a net under the keepalive, not a precondition for it. A throw
   * escaping the arm would reject startConnectedForegroundService before its
   * displayNotification, so a broken AlarmManager would silently cost the user
   * the keepalive.
   *
   * Mutation seen failing: removing the try/catch around armStopAlarm fails with
   * "expected [Function] to not throw an error but 'Error: AlarmManager
   * refused' was thrown".
   */
  it('swallows a native failure rather than blocking the keepalive', async () => {
    nativeModuleState.module = {
      armStopAlarm: () => {
        throw new Error('AlarmManager refused');
      },
      disarmStopAlarm: () => {
        throw new Error('AlarmManager refused');
      },
    };
    const guard = await loadGuard();

    expect(() => guard.armForegroundServiceStopAlarm(123_456)).not.toThrow();
    expect(() => guard.disarmForegroundServiceStopAlarm()).not.toThrow();
  });

  it('is a no-op where the native module is absent, such as a build without it', async () => {
    const guard = await loadGuard();

    expect(() => guard.armForegroundServiceStopAlarm(123_456)).not.toThrow();
    expect(() => guard.disarmForegroundServiceStopAlarm()).not.toThrow();
  });

  it('never looks the module up off Android', async () => {
    platformMock.OS = 'ios';
    const guard = await loadGuard();

    guard.armForegroundServiceStopAlarm(123_456);

    expect(nativeModuleState.requestedNames).toEqual([]);
  });
});

describe('foreground-service-guard native source', () => {
  const guardKotlin = withoutComments(readModuleFile(kotlinRoot, 'ForegroundServiceGuard.kt'));
  const moduleKotlin = withoutComments(readModuleFile(kotlinRoot, 'ForegroundServiceGuardModule.kt'));
  const receiverKotlin = withoutComments(readModuleFile(kotlinRoot, 'ForegroundServiceGuardReceiver.kt'));
  const manifest = readModuleFile(moduleRoot, 'android', 'src', 'main', 'AndroidManifest.xml');
  const buildGradle = readModuleFile(moduleRoot, 'android', 'build.gradle');
  const moduleConfig = JSON.parse(readModuleFile(moduleRoot, 'expo-module.config.json')) as {
    platforms: string[];
    android: { modules: string[] };
  };
  const wrapperTypeScript = readModuleFile(moduleRoot, 'index.ts');

  /**
   * THE static-state trap. notifee's onStartCommand skips startForeground while
   * its static current-notification id is set. Only the STOP action, or
   * notifee's completion callback when the JS runner resolves, clears it. A
   * bare stopService leaves it set until JS next stops, and a start landing
   * first would crash with "did not then call Service.startForeground()". So
   * the stop is the STOP action delivered through startService, which is
   * correct without relying on JS, with stopService only as the fallback for a
   * refused background start.
   *
   * Mutation seen failing: replacing the whole try/catch with a bare
   * `context.stopService(stopIntent)` fails with "expected 'package
   * expo.modules.foregroundservic…' to match /context\.startService\(stopIntent\)/".
   */
  it('stops through notifee\'s own STOP action, not a bare stopService', () => {
    expect(guardKotlin).toContain(`"${NOTIFEE_FOREGROUND_SERVICE}"`);
    expect(guardKotlin).toContain(`"${NOTIFEE_FOREGROUND_SERVICE}.STOP"`);
    expect(guardKotlin).toMatch(/\.setAction\(NOTIFEE_STOP_ACTION\)/);
    expect(guardKotlin).toMatch(/context\.startService\(stopIntent\)/);
    expect(guardKotlin).toMatch(/catch \(illegalState: IllegalStateException\)\s*\{\s*context\.stopService\(stopIntent\)/);
  });

  /**
   * SCHEDULE_EXACT_ALARM is denied by default from Android 14, and USE_EXACT_ALARM
   * is reserved for alarm and calendar apps. An exact alarm would throw a
   * SecurityException at arm time on most installs, and the wrapper would
   * swallow it: no net, and no sign of its absence. The inexact allow-while-idle
   * alarm needs neither and still fires in Doze. It is on elapsed realtime,
   * which keeps counting through deep sleep, unlike the uptime the FGS budget
   * accrues on.
   */
  it('arms an inexact, Doze-firing, elapsed-realtime alarm that needs no exact-alarm permission', () => {
    expect(guardKotlin).toContain('setAndAllowWhileIdle(');
    expect(guardKotlin).toContain('AlarmManager.ELAPSED_REALTIME_WAKEUP');
    expect(guardKotlin).not.toMatch(/setExact|setAlarmClock/);
  });

  it('keys the alarm to one immutable explicit PendingIntent, so re-arming replaces and cancel matches', () => {
    expect(guardKotlin).toMatch(/PendingIntent\.getBroadcast\(\s*context,\s*REQUEST_CODE,/);
    expect(guardKotlin).toContain('PendingIntent.FLAG_IMMUTABLE');
    expect(guardKotlin).toMatch(/Intent\(context, ForegroundServiceGuardReceiver::class\.java\)/);
  });

  it('declares the receiver unexported, under the class name the Kotlin defines', () => {
    expect(manifest).toMatch(
      /<receiver\s+android:name="\.ForegroundServiceGuardReceiver"\s+android:exported="false"\s*\/>/,
    );
    expect(receiverKotlin).toContain('class ForegroundServiceGuardReceiver : BroadcastReceiver()');
    expect(receiverKotlin).toContain('ForegroundServiceGuard.stopNotifeeService(context)');
    expect(buildGradle).toContain('namespace "expo.modules.foregroundserviceguard"');
  });

  /**
   * The names that tie the halves together and that nothing else checks: a
   * mismatch leaves requireOptionalNativeModule returning null, which the
   * wrapper treats as "no module" and turns every arm into a silent no-op.
   */
  it('registers the module under the names the JS wrapper calls', () => {
    expect(moduleConfig.platforms).toEqual(['android']);
    expect(moduleConfig.android.modules).toEqual(['expo.modules.foregroundserviceguard.ForegroundServiceGuardModule']);
    expect(moduleKotlin).toContain('Name("ForegroundServiceGuard")');
    expect(wrapperTypeScript).toContain("requireOptionalNativeModule<ForegroundServiceGuardNativeModule>('ForegroundServiceGuard')");
    // Synchronous Function, not AsyncFunction: the arm must have landed before
    // displayNotification is issued.
    expect(moduleKotlin).toMatch(/\bFunction\("armStopAlarm"\)/);
    expect(moduleKotlin).toMatch(/\bFunction\("disarmStopAlarm"\)/);
    expect(moduleKotlin).not.toContain('AsyncFunction');
  });

  /**
   * Everything above was read out of notifee 9.1.8's bytecode: the STOP action
   * string, START_NOT_STICKY after a start (why a sticky restart is not a start
   * path), the static id that a bare stopService leaves set, and the absence of
   * an onTimeout override. None of that is public API. On any version change,
   * re-run `javap -c -p` on app.notifee.core.ForegroundService from the new AAR's
   * classes.jar and re-check all four. If the new version overrides onTimeout,
   * this alarm may be replaceable. Then update the pinned version here.
   */
  it('runs against the notifee version whose service internals were verified', () => {
    const installed = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'node_modules', '@notifee', 'react-native', 'package.json'), 'utf8'),
    ) as { version: string };

    expect(installed.version).toBe('9.1.8');
  });
});
