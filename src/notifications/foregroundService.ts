import notifee, { AndroidForegroundServiceType } from '@notifee/react-native';
import { nativeStopAlarmEnabled, stopSettleWaitEnabled, traceConnection } from '@/devsupport/connectionTrace';
import {
  armForegroundServiceStopAlarm,
  awaitForegroundServiceStopped,
  disarmForegroundServiceStopAlarm,
} from '../../modules/foreground-service-guard';
import { CONNECTION_NOTIFICATION_ID } from './categoryCopy';
import { ANDROID_NOTIFICATION_PRESENTATION, CONNECTION_CHANNEL_ID } from './channels';

/**
 * The Android "stay connected" foreground service: a LOW-importance
 * ongoing notification that lets the process keep the relay socket and
 * Noise session alive while backgrounded (backgroundNotificationsMode
 * 'foreground-service'). The service type is dataSync, matching the
 * manifest declaration in plugins/withAndroidPushService.ts (Android 14+
 * requires the two to agree or startForeground crashes).
 *
 * This module owns the NATIVE state, and callers only ever declare what they
 * want. That split is the repair for MOBILE-3. The previous shape exported a
 * bare start and a bare stop, and connectionManager called them through two
 * independent dynamic imports with no ordering between them, so a
 * background -> active -> background bounce could resolve the start's
 * `displayNotification` AFTER the stop had already run: a live dataSync
 * service with no ceiling timer behind it and JS believing it was stopped. A
 * stop that then failed was swallowed, leaving the same orphan. Both crash
 * events show the consequence - the app backgrounded, never returned, and the
 * process was still alive 7 and 14 hours later.
 *
 * So: one desired state, one serialized reconcile loop, and a stop that is
 * retried rather than swallowed. Start and stop cannot interleave their SENDS,
 * because the loop only ever has one native call in flight.
 *
 * Their LANDING is a separate matter, and Sentry MOBILE-J (1.5.1+22) is what
 * that difference costs. This used to say flatly that start and stop "cannot
 * interleave", and of the sends it was true. But notifee's stopForegroundService
 * resolves once its STOP intent is SENT (read from the 9.1.8 bytecode), and the
 * STOP branch then calls stopSelf() with no start id, which AOSP's
 * stopServiceTokenLocked treats as unconditional. So a start issued straight
 * after a stop reached the system while the STOP still sat in the main thread's
 * queue, the STOP ran, and bringDownServiceLocked crashed the app because the
 * start's startForeground was still owed. The field trigger was a notification
 * tap that resumed and paused the activity twice in about 80 ms. So a start that
 * follows a stop now waits, natively, until the service record is gone, which
 * means the STOP has run (awaitQueuedStop below). The opposite order needs no
 * wait: a STOP sent after a start runs behind it on the same thread, and its
 * startService clears the start's obligation in AMS besides.
 *
 * And a native stop alarm under all of it, because MOBILE-3 recurred on a build
 * that had everything above (0.8.0+13). Every start arms an AlarmManager alarm
 * (modules/foreground-service-guard) before the service can exist, and every
 * stop that has been issued cancels it. If the alarm fires, native code stops the
 * service whether or not the JS thread is running. That is the only part of this
 * stack that does not depend on JS, and the field failure is precisely JS not
 * running its stop.
 *
 * THIS IS THE ONE START PATH. startConnectedForegroundService below is the only
 * code that passes `asForegroundService`, so every way the dataSync service can
 * start goes through the arm. tests/unit/foregroundServiceStartConfinement.test.ts
 * fails if a second one appears anywhere in src/ or app/. The headless push task
 * posts without it, and the push-service plugin only edits the manifest.
 */

/**
 * When the native stop alarm fires. That is connectionManager's five-minute JS
 * ceiling (BACKGROUND_KEEPALIVE_MAX_MS) plus one of the desktop's ~2 minute
 * rekey intervals, which is the latest the JS wall-clock check can land when the
 * timer half is not firing. So the orderly JS teardown, which stops the service
 * and THEN closes the channel, gets first chance. If both happen to land
 * together, the second stop is a no-op.
 *
 * The alarm is inexact, so it never fires early but can fire later. Measured at
 * the earlier 10-minute setting (`dumpsys alarm`, API 36 emulator, 2026-10-06):
 * the window was 75% of the delay, and the alarm fired at the very end of it,
 * 17m29s in. It was shortened to 7 minutes for that reason: a frozen JS thread
 * leaves the "Connected to your desktop" notification up until the alarm, and
 * 75% of 7 minutes puts the latest at about 12m15s. A 7-minute reading on the
 * same emulator confirmed it: window +5m15s, latest +12m11s from the arm. That
 * is far inside Android's 6h budget. Held as a literal in the tests, so raising
 * this towards hours would turn them red.
 */
const NATIVE_STOP_ALARM_DELAY_MS = 7 * 60_000;

/**
 * Immediate retries, deliberately with no delay between them. A backoff would
 * need setTimeout, and a starved JS timer is one of the things this module has
 * to survive - see connectionManager's BACKGROUND_KEEPALIVE_MAX_MS. A stop that
 * fails all of these stays owed: the next reassert from a wake source that is
 * not Choreographer-driven picks it up.
 *
 * Know how rare that failure is. Read from notifee 9.1.8's bytecode:
 * Notifee.stopForegroundService completes its callback with no error even when
 * it has just logged "Unable to stop foreground service", so the native call
 * resolves whatever happened. A rejection here therefore means the bridge call
 * itself failed. That is also why "resolved" is evidence the stop was SENT, not
 * that it landed, and why a stop that was never sent (JS not running) is the
 * case the native stop alarm exists for.
 */
const STOP_ATTEMPTS = 3;

/**
 * How long a start waits for an earlier STOP to have run (MOBILE-J). A STOP is a
 * main-thread message, so it normally runs within a few frames. Measured on
 * emulators during resume-and-pause bursts (2026-11-21, docs/architecture.md):
 * 0 to 81 ms on API 36, and 1 to 498 ms on Android 17's terminal lens, so this is
 * four times the worst wait seen. The bound only matters when the main thread is
 * stuck, or when the STOP was never delivered. In both cases the start is skipped
 * rather than sent, because sending it is the crash. See the timed-out branch in
 * runReconcileLoop.
 */
const STOP_SETTLE_TIMEOUT_MS = 2_000;

let runnerRegistered = false;
let resolveServiceRunner: (() => void) | null = null;

let desiredRunning = false;
/**
 * Bumped by every declaration, so every call is honoured with a real native
 * call rather than being skipped as "already in that state". The service can
 * stop existing without JS hearing about it (a process restart, an OS kill),
 * and an in-process boolean could never notice.
 */
let desiredSequence = 0;
let appliedSequence = 0;
/** Set when a stop exhausted its attempts, so the work stays owed rather than lost. */
let stopFailed = false;
/**
 * Set whenever a stop is issued, and cleared only once the native query shows
 * notifee's service gone. While it is set, a STOP may still be queued on the
 * main thread, and a start must not be sent behind it (MOBILE-J).
 */
let stopMayBeQueued = false;
let reconciling: Promise<void> | null = null;

/**
 * Must run at module/boot scope before the first desired-true declaration:
 * notifee requires the long-running task to be registered before the service
 * notification is displayed. The returned promise resolving is what actually
 * lets notifee's headless JS task finish, so the resolver is parked until the
 * stop.
 */
export function registerForegroundServiceRunner(): void {
  if (runnerRegistered) return;
  runnerRegistered = true;
  notifee.registerForegroundService(
    () =>
      new Promise<void>((resolve) => {
        // notifee invokes the runner once per service start, and the resolver
        // lives in a single module slot. A previous invocation whose resolver
        // was never called leaves its headless JS task parked forever, and RN
        // keeps servicing timers only while a headless task is active - so a
        // stranded one quietly changes the timer behaviour of the whole app.
        // Release it before parking the new one.
        resolveServiceRunner?.();
        if (!desiredRunning) {
          // This invocation belongs to a service nothing in this process asked
          // for, which the boot sweep is about to stop (or already has). Parking
          // here would strand the headless task against a service that no
          // longer exists. Rare rather than routine: notifee returns
          // START_NOT_STICKY after a start, so Android recreates the service only
          // to deliver a start intent still pending when the process died.
          //
          // The mirror case is NOT handled here and does not need to be: when the
          // native stop alarm stops a service JS still wants, the resolver stays
          // parked until JS next runs a stop, and every later start is
          // serialized behind that stop.
          resolve();
          resolveServiceRunner = null;
          return;
        }
        resolveServiceRunner = resolve;
      }),
  );
}

/**
 * Declare whether the connection foreground service should be running. Safe to
 * call repeatedly and in any order; the reconcile loop applies declarations in
 * the order they arrive, one native call at a time.
 */
export function setConnectedForegroundServiceDesired(running: boolean): void {
  desiredRunning = running;
  desiredSequence += 1;
  stopFailed = false;
  kickReconcileLoop();
}

/**
 * Re-run any native call the last declaration still owes. A no-op when there is
 * nothing outstanding, which is the normal case.
 *
 * The point is the abnormal case: a stop that failed every attempt stays owed,
 * and this is how it gets retried from a wake source that does not depend on a
 * JS timer (an inbound relay frame, an AppState transition).
 *
 * WHAT THIS CANNOT REACH, which is why the native stop alarm exists. Hitting the
 * ceiling closes the channel, so after a failed stop there are no more rekeys
 * and the only wake source left is the user returning to the app. In the
 * MOBILE-3 shape every wake source goes at once: no channel, so no rekey; no
 * foreground visit, so no AppState transition; no process death, so no boot
 * sweep. This comment used to end by calling the native alarm "deliberately not
 * built until a device probe shows a stop actually failing in the field". Build
 * 13 (0.8.0+13, Sentry MOBILE-3, 2026-10-06) is that field failure, so the
 * alarm is now built (see the file header). One correction to how it was
 * framed: the field failure is a stop that JS never SENT, not one that failed.
 * notifee's stop resolves whatever happens (see STOP_ATTEMPTS), so this retry
 * path is a defence against a bridge failure. The alarm is the defence against
 * a JS thread that is not running.
 */
export function reassertConnectedForegroundService(): void {
  if (!stopFailed) return;
  stopFailed = false;
  kickReconcileLoop();
}

/**
 * One unconditional stop at process start, before anything can have declared a
 * desired state. notifee's stopForegroundService is an unconditional native
 * call, so issuing it once costs nothing when there is no service to stop. The
 * same path also cancels a stop alarm a previous process left armed, so that
 * alarm cannot start this process later for nothing.
 *
 * CORRECTED PREMISE. This used to say "Android can restart a foreground service
 * after a process death with nothing in JS tracking it", as if that were routine.
 * Read from notifee 9.1.8's bytecode, it is not: onStartCommand returns
 * START_NOT_STICKY after a start, so Android recreates the service only to
 * deliver a start intent that was still pending when the process died. The
 * sweep stays, as cheap insurance for that narrow case. The long-lived orphan
 * that MOBILE-3 actually is lives in a process that never died, which this
 * sweep can never see. The native stop alarm covers that case.
 */
export function stopOrphanedForegroundServiceAtBoot(): void {
  // Parked in the same slot the reconcile loop uses, so a keepalive declared
  // while this native call is still in flight queues behind it instead of
  // racing it. Without that the sweep is the one native call in this module
  // nothing serializes: an early background transition could land
  // displayNotification underneath it and lose the service it just started,
  // which is the interleaving the whole module exists to prevent.
  if (reconciling) return;
  // Through the same stop the reconciler uses, not a bare native call: that one
  // also releases a parked runner resolver, so the headless task cannot outlive
  // the service it belongs to.
  reconciling = stopConnectedForegroundService()
    .catch(() => {
      // Nothing was running, or notifee is not ready yet. Either way the normal
      // keepalive path owns the service from here.
    })
    .finally(() => {
      reconciling = null;
      if (hasOutstandingWork() && !stopFailed) kickReconcileLoop();
    });
}

function hasOutstandingWork(): boolean {
  return appliedSequence !== desiredSequence;
}

function kickReconcileLoop(): void {
  if (reconciling) return;
  reconciling = runReconcileLoop().finally(() => {
    reconciling = null;
    // A declaration that arrived while the loop was winding down would
    // otherwise be lost: its kick saw a non-null `reconciling`, and the loop
    // had already made its last pass. That window is a microtask wide and it
    // swallowed the very first keepalive start.
    if (hasOutstandingWork() && !stopFailed) kickReconcileLoop();
  });
}

async function runReconcileLoop(): Promise<void> {
  while (hasOutstandingWork()) {
    const sequence = desiredSequence;
    const shouldRun = desiredRunning;
    if (shouldRun) {
      // Marked applied before the await on purpose: once displayNotification
      // has been issued the service may exist, so a later stop is owed whether
      // or not this call resolves.
      appliedSequence = sequence;
      if (stopMayBeQueued && stopSettleWaitEnabled()) {
        const settled = await awaitQueuedStop();
        if (sequence !== desiredSequence) {
          // Superseded while waiting, which is what a burst of foreground and
          // background transitions looks like. Apply the newer declaration
          // instead. A burst that ends stopped then sends no start at all.
          continue;
        }
        if (!settled) {
          // The service is still there after the bound: the main thread is
          // stuck with the STOP queued, or the STOP was never delivered. Sending
          // the start is the crash in the first case, so skip it in both. The
          // keepalive degrades to a plain background socket, as it does when the
          // notification fails to post. The alarm is still armed, because in the
          // second case the service the STOP missed is still running, and the
          // stop that preceded this start has already disarmed it. The flag
          // stays set, so the next start waits again.
          if (nativeStopAlarmEnabled()) armForegroundServiceStopAlarm(NATIVE_STOP_ALARM_DELAY_MS);
          continue;
        }
      }
      try {
        await startConnectedForegroundService();
      } catch {
        // The service notification failing to post (permission denied) leaves
        // a plain background socket; the OS may reap it sooner, nothing worse.
      }
      continue;
    }
    if (await attemptStop()) {
      appliedSequence = sequence;
      continue;
    }
    if (sequence !== desiredSequence) {
      // A newer declaration landed while those attempts were failing, and it
      // supersedes this stop. Loop again and apply it - a start if the app
      // bounced back to the background, a fresh set of attempts if it is
      // another stop. Falling through to mark the failure instead would strand
      // that declaration outright: the re-kick in kickReconcileLoop is gated on
      // !stopFailed, so nothing would apply it until the next wake source.
      continue;
    }
    // Every attempt failed. Leave the stop owed so reassert retries it, and
    // leave the loop rather than spinning against a native call that is not
    // currently working.
    stopFailed = true;
    return;
  }
}

/**
 * Waits until the last STOP has actually run: notifee's service has no record
 * left in the system. True when it is gone, false at STOP_SETTLE_TIMEOUT_MS.
 *
 * A native wait, never a JS poll. React Native stops servicing JS timers once
 * the activity pauses unless a headless task is running (inferred from RN's
 * JavaTimerManager), and a start runs on exactly that transition, just after the
 * previous keepalive's runner was released. A native promise resolves either way.
 */
async function awaitQueuedStop(): Promise<boolean> {
  const startedAtMs = Date.now();
  const settled = await awaitForegroundServiceStopped(STOP_SETTLE_TIMEOUT_MS);
  traceConnection('fgs-stop-settle', { settled, waitedMs: Date.now() - startedAtMs });
  if (settled) stopMayBeQueued = false;
  return settled;
}

async function attemptStop(): Promise<boolean> {
  for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt += 1) {
    try {
      await stopConnectedForegroundService();
      return true;
    } catch {
      // Retried below; the last failure falls through to the caller.
    }
  }
  return false;
}

async function startConnectedForegroundService(): Promise<void> {
  // BEFORE the display, for the same reason appliedSequence is marked before
  // the await: once displayNotification is issued the service may exist, and a
  // service that exists without the alarm behind it is the MOBILE-3 exposure.
  // The arm is a synchronous native call, so it has landed by the next line.
  // Every start re-arms the one alarm slot, so a fresh keepalive gets a fresh
  // deadline rather than inheriting an earlier one.
  if (nativeStopAlarmEnabled()) armForegroundServiceStopAlarm(NATIVE_STOP_ALARM_DELAY_MS);
  await notifee.displayNotification({
    id: CONNECTION_NOTIFICATION_ID,
    title: 'Connected to your desktop',
    body: 'Keeping the secure channel alive for instant alerts.',
    android: {
      ...ANDROID_NOTIFICATION_PRESENTATION,
      channelId: CONNECTION_CHANNEL_ID,
      asForegroundService: true,
      ongoing: true,
      foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
      pressAction: { id: 'default', launchActivity: 'default' },
    },
  });
}

async function stopConnectedForegroundService(): Promise<void> {
  // Order is load-bearing: resolving the runner is what lets notifee's headless
  // JS task finish, and stopForegroundService is what tears the service down.
  resolveServiceRunner?.();
  resolveServiceRunner = null;
  // Before the call, not after it resolves: a call that rejects may still have
  // sent its STOP, and a STOP that may be queued is what the next start waits on.
  // This covers every stop, the boot sweep and the reassert retry included.
  stopMayBeQueued = true;
  await notifee.stopForegroundService();
  // Only AFTER the stop resolved, i.e. was sent. A stop that rejects leaves the
  // alarm armed, and an owed stop is precisely what the alarm is for.
  disarmForegroundServiceStopAlarm();
}
