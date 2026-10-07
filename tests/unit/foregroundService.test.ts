/**
 * The Android "stay connected" foreground service: the ongoing notification
 * presented while the process keeps the relay socket alive in the background,
 * and the reconcile loop that owns whether it is actually running.
 *
 * The loop exists because of MOBILE-3. The module used to export a bare start
 * and a bare stop that connectionManager called through two independent dynamic
 * imports, so they could interleave and leave a live dataSync service behind
 * with JS believing it was stopped, and a failed stop was swallowed. Both
 * regression tests below were watched failing against that shape before being
 * kept - see each one's comment for the mutation.
 *
 * Every test reloads the module: the desired/applied sequence is module state,
 * so a shared instance would carry one test's outstanding work into the next.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import notifee from '@notifee/react-native';
import { brandTokens } from '@/components/theme/tokens';
import { flushMicrotasks } from '../helpers/async';

// AndroidImportance and AuthorizationStatus are unused here, but foregroundService.ts
// reaches channels.ts (for ANDROID_NOTIFICATION_PRESENTATION), which imports both at
// module scope. Omitting them only works while nothing evaluates them at import time.
vi.mock('@notifee/react-native', () => ({
  default: {
    displayNotification: vi.fn(async () => 'notification-id'),
    registerForegroundService: vi.fn(),
    stopForegroundService: vi.fn(async () => undefined),
  },
  AndroidForegroundServiceType: { FOREGROUND_SERVICE_TYPE_DATA_SYNC: 1 },
  AndroidImportance: { DEFAULT: 3, HIGH: 4, LOW: 2 },
  AuthorizationStatus: { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 },
}));

/**
 * The native stop alarm (MOBILE-3 on 0.8.0+13). Mocked at the JS wrapper, which
 * resolves to the same module the source imports: this file and
 * src/notifications/foregroundService.ts both sit two directories below the repo
 * root. What the alarm does once armed is Kotlin, which no JS tier can load. The
 * device run in the developer guide covers that half.
 */
const stopAlarmMocks = vi.hoisted(() => ({
  armForegroundServiceStopAlarm: vi.fn<(delayMs: number) => void>(),
  disarmForegroundServiceStopAlarm: vi.fn<() => void>(),
}));
vi.mock('../../modules/foreground-service-guard', () => stopAlarmMocks);

/** Must match NATIVE_STOP_ALARM_DELAY_MS. A literal on purpose, so raising it towards hours fails here. */
const EXPECTED_STOP_ALARM_DELAY_MS = 7 * 60_000;

type ForegroundServiceRunner = Parameters<typeof notifee.registerForegroundService>[0];
type ForegroundServiceNotification = Parameters<ForegroundServiceRunner>[0];

async function loadForegroundService() {
  vi.resetModules();
  const notifeeModule = await import('@notifee/react-native');
  const moduleUnderTest = await import('@/notifications/foregroundService');
  const displayNotification = vi.mocked(notifeeModule.default.displayNotification);
  const stopForegroundService = vi.mocked(notifeeModule.default.stopForegroundService);
  const registerForegroundService = vi.mocked(notifeeModule.default.registerForegroundService);
  displayNotification.mockReset();
  displayNotification.mockResolvedValue('notification-id');
  stopForegroundService.mockReset();
  stopForegroundService.mockResolvedValue(undefined);
  registerForegroundService.mockReset();
  stopAlarmMocks.armForegroundServiceStopAlarm.mockReset();
  stopAlarmMocks.disarmForegroundServiceStopAlarm.mockReset();
  return {
    ...moduleUnderTest,
    displayNotification,
    stopForegroundService,
    registerForegroundService,
    armStopAlarm: stopAlarmMocks.armForegroundServiceStopAlarm,
    disarmStopAlarm: stopAlarmMocks.disarmForegroundServiceStopAlarm,
  };
}

describe('foregroundService', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('displays the connection notification with the branded small icon and color', async () => {
    const service = await loadForegroundService();

    service.setConnectedForegroundServiceDesired(true);
    await vi.waitFor(() => expect(service.displayNotification).toHaveBeenCalledTimes(1));

    const notification = service.displayNotification.mock.calls[0][0];
    expect(notification.title).toBe('Connected to your desktop');
    expect(notification.android?.channelId).toBe('connection');
    expect(notification.android?.asForegroundService).toBe(true);
    // Notifee defaults smallIcon to ic_launcher (a full-colour asset the OS
    // strips to a silhouette) unless set explicitly - see channels.ts.
    expect(notification.android?.smallIcon).toBe('notification_icon');
    expect(notification.android?.color).toBe(brandTokens.rust);
  });

  it('declares the dataSync service type the manifest also declares', async () => {
    const service = await loadForegroundService();

    service.setConnectedForegroundServiceDesired(true);
    await vi.waitFor(() => expect(service.displayNotification).toHaveBeenCalledTimes(1));

    // Android 14+ crashes at startForeground time unless this agrees with
    // plugins/withAndroidPushService.ts, and nothing else pins the pair.
    expect(service.displayNotification.mock.calls[0][0].android?.foregroundServiceTypes).toEqual([1]);
    expect(service.displayNotification.mock.calls[0][0].android?.ongoing).toBe(true);
  });

  it('registers the long-running task once, however many times it is called', async () => {
    const service = await loadForegroundService();

    service.registerForegroundServiceRunner();
    service.registerForegroundServiceRunner();

    expect(service.registerForegroundService).toHaveBeenCalledTimes(1);
  });

  it('stops the service when the desired state goes false', async () => {
    const service = await loadForegroundService();

    service.setConnectedForegroundServiceDesired(true);
    await vi.waitFor(() => expect(service.displayNotification).toHaveBeenCalledTimes(1));
    service.setConnectedForegroundServiceDesired(false);

    await vi.waitFor(() => expect(service.stopForegroundService).toHaveBeenCalledTimes(1));
  });

  it('serializes a stop declared while the start is still in flight', async () => {
    const service = await loadForegroundService();
    let resolveDisplay: (id: string) => void = () => undefined;
    service.displayNotification.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveDisplay = resolve;
        }),
    );

    service.setConnectedForegroundServiceDesired(true);
    await flushMicrotasks();
    service.setConnectedForegroundServiceDesired(false);
    await flushMicrotasks();

    // THE assertion. With the old two-independent-calls shape the stop ran here,
    // against a service that had not been posted yet, and the start then landed
    // behind it - a live dataSync service with nothing tracking it. Mutating
    // setConnectedForegroundServiceDesired back to calling start/stop directly
    // makes this line fail with 1 call instead of 0; the later waitFor stays
    // green either way, which is why the negative assertion is the load-bearing
    // one rather than the call count at the end.
    expect(service.stopForegroundService).not.toHaveBeenCalled();

    resolveDisplay('notification-id');
    await vi.waitFor(() => expect(service.stopForegroundService).toHaveBeenCalledTimes(1));
  });

  it('retries a rejected stop, and leaves it owed for the next reassert', async () => {
    const service = await loadForegroundService();
    service.setConnectedForegroundServiceDesired(true);
    await vi.waitFor(() => expect(service.displayNotification).toHaveBeenCalledTimes(1));

    service.stopForegroundService.mockRejectedValue(new Error('native stop failed'));
    service.setConnectedForegroundServiceDesired(false);
    await vi.waitFor(() => expect(service.stopForegroundService).toHaveBeenCalledTimes(3));

    // Owed, not swallowed. The old code caught the rejection and moved on, so
    // the service stayed up with no record that it had. Mutating the reconcile
    // loop to mark the sequence applied on a failed stop makes the reassert a
    // no-op and this final expectation times out at 3.
    service.stopForegroundService.mockResolvedValue(undefined);
    service.reassertConnectedForegroundService();
    await vi.waitFor(() => expect(service.stopForegroundService).toHaveBeenCalledTimes(4));
  });

  /**
   * A start declared while a failing stop is still retrying used to be
   * stranded: attemptStop() exhausting its three attempts set stopFailed and
   * returned, and kickReconcileLoop's re-kick is gated on !stopFailed, so the
   * pending true declaration sat unapplied until some later external wake
   * source called reassertConnectedForegroundService(). The fix is the
   * `sequence !== desiredSequence` check right after attemptStop() fails: a
   * newer declaration landed while those attempts were failing, so the loop
   * continues and applies it instead of marking the stop failed.
   *
   * Every stop attempt below is a hand-controlled promise, not a plain
   * mockRejectedValue: rejecting all three synchronously would settle them
   * within the same microtask tick, and the true declaration could never
   * actually land while attemptStop() was still awaiting one of them.
   *
   * Deleting the `if (sequence !== desiredSequence) { continue; }` block makes
   * the second displayNotification call never arrive, and this test times out
   * instead.
   */
  it('applies a start declared while a failing stop is still retrying, without an external reassert', async () => {
    const service = await loadForegroundService();
    service.setConnectedForegroundServiceDesired(true);
    await vi.waitFor(() => expect(service.displayNotification).toHaveBeenCalledTimes(1));

    const pendingStopAttempts: ((reason: Error) => void)[] = [];
    service.stopForegroundService.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          pendingStopAttempts.push(reject);
        }),
    );

    service.setConnectedForegroundServiceDesired(false);
    await flushMicrotasks();
    expect(pendingStopAttempts).toHaveLength(1);

    // Fail the first attempt and let the loop start its second.
    pendingStopAttempts[0](new Error('native stop failed'));
    await flushMicrotasks();
    expect(pendingStopAttempts).toHaveLength(2);

    // THE interleaving under test: a fresh start declared while the second of
    // three retry attempts is genuinely still pending.
    service.setConnectedForegroundServiceDesired(true);

    // Fail the second and third attempts so attemptStop() exhausts all three
    // and the reconcile loop reaches the branch under test.
    pendingStopAttempts[1](new Error('native stop failed'));
    await flushMicrotasks();
    expect(pendingStopAttempts).toHaveLength(3);
    pendingStopAttempts[2](new Error('native stop failed'));

    // No call to service.reassertConnectedForegroundService anywhere in this
    // test: the start has to apply on its own, inside the same reconcile loop
    // that was already running the failing stop.
    await vi.waitFor(() => expect(service.displayNotification).toHaveBeenCalledTimes(2));
  });

  it('releases a parked runner promise before parking the next one', async () => {
    const service = await loadForegroundService();
    service.registerForegroundServiceRunner();
    // A service the app actually asked for, so the runner parks rather than
    // taking the "nothing asked for this" exit the next test covers.
    service.setConnectedForegroundServiceDesired(true);
    await vi.waitFor(() => expect(service.displayNotification).toHaveBeenCalledTimes(1));
    const runner = service.registerForegroundService.mock.calls[0][0];
    const notification = {} as ForegroundServiceNotification;

    let firstRunnerSettled = false;
    void runner(notification).then(() => {
      firstRunnerSettled = true;
    });
    await flushMicrotasks();
    expect(firstRunnerSettled).toBe(false);

    // notifee invokes the runner once per service start and the resolver lives
    // in a single slot, so without this release the first headless JS task is
    // parked forever - and RN services timers only while one is active, so a
    // stranded task silently changes timer behaviour app-wide.
    void runner(notification);
    await flushMicrotasks();
    expect(firstRunnerSettled).toBe(true);
  });

  it('queues a keepalive declared while the boot sweep is still in flight', async () => {
    const service = await loadForegroundService();
    let resolveStop: () => void = () => undefined;
    service.stopForegroundService.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        }),
    );

    service.stopOrphanedForegroundServiceAtBoot();
    await flushMicrotasks();
    service.setConnectedForegroundServiceDesired(true);
    await flushMicrotasks();

    // THE assertion. The boot sweep is the one native call in the module that
    // does not arrive through a desired-state declaration, so nothing sequences
    // it unless it parks in the same slot the reconcile loop uses. Unparked, the
    // start below lands underneath a stop that has not returned yet and loses
    // the service it just posted - the interleaving this module exists to
    // prevent, reached from the one direction the sequence counters cannot see.
    expect(service.displayNotification).not.toHaveBeenCalled();

    resolveStop();

    // And it is queued, not dropped: the sweep's own completion has to hand the
    // loop back its outstanding work. Deleting the re-kick from the sweep's
    // finally makes this time out rather than fail fast, since the declaration
    // is simply never applied.
    await vi.waitFor(() => expect(service.displayNotification).toHaveBeenCalledTimes(1));
  });

  it('finishes the runner immediately for a service nothing asked for', async () => {
    const service = await loadForegroundService();
    service.registerForegroundServiceRunner();
    service.stopOrphanedForegroundServiceAtBoot();
    await vi.waitFor(() => expect(service.stopForegroundService).toHaveBeenCalledTimes(1));

    // Android restarted the service after a process death, so notifee invokes
    // the runner for a service the boot sweep is stopping. Parking here would
    // leave the headless JS task alive against a service that no longer exists,
    // and RN services timers only while a headless task is active - the exact
    // condition that makes timer behaviour unpredictable app-wide. Removing the
    // !desiredRunning branch from the runner makes this hang at false.
    const runner = service.registerForegroundService.mock.calls[0][0];
    let runnerSettled = false;
    void runner({} as ForegroundServiceNotification).then(() => {
      runnerSettled = true;
    });
    await flushMicrotasks();

    expect(runnerSettled).toBe(true);
  });

  describe('the native stop alarm', () => {
    /**
     * THE MOBILE-3 assertion. The field failure is a service that outlived a JS
     * thread which never ran its stop, so the bound that does not need JS has to
     * be in place before the service can exist. That means armed with the real
     * delay, and armed BEFORE displayNotification is issued.
     *
     * Mutations seen failing: deleting the arm from startConnectedForegroundService
     * fails the first expectation with "expected "vi.fn()" to be called with
     * arguments: [ 600000 ]" (written when the deadline was ten minutes). Moving
     * it below the awaited displayNotification fails the call-order expectation
     * instead ("expected 39 to be less than 38"). Putting the constant back to
     * ten minutes fails it too, which is what the literal is for.
     */
    it('arms the alarm with the seven-minute deadline before the service is started', async () => {
      const service = await loadForegroundService();

      service.setConnectedForegroundServiceDesired(true);
      await vi.waitFor(() => expect(service.displayNotification).toHaveBeenCalledTimes(1));

      expect(service.armStopAlarm).toHaveBeenCalledWith(EXPECTED_STOP_ALARM_DELAY_MS);
      expect(service.armStopAlarm.mock.invocationCallOrder[0]).toBeLessThan(
        service.displayNotification.mock.invocationCallOrder[0],
      );
    });

    /**
     * Cancelled only once the stop has been SENT. A cancel ahead of the await
     * would leave a window, and on a stop that never resolves a permanent gap,
     * in which the service is still up with nothing native behind it.
     *
     * Mutation seen failing: moving disarmForegroundServiceStopAlarm() above
     * `await notifee.stopForegroundService()` fails the not-yet expectation with
     * "expected "vi.fn()" to not be called at all, but actually been called 1
     * times".
     */
    it('cancels the alarm only after a normal stop has resolved', async () => {
      const service = await loadForegroundService();
      service.setConnectedForegroundServiceDesired(true);
      await vi.waitFor(() => expect(service.displayNotification).toHaveBeenCalledTimes(1));

      let resolveStop: () => void = () => undefined;
      service.stopForegroundService.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveStop = resolve;
          }),
      );
      service.setConnectedForegroundServiceDesired(false);
      await vi.waitFor(() => expect(service.stopForegroundService).toHaveBeenCalledTimes(1));
      await flushMicrotasks();

      expect(service.disarmStopAlarm).not.toHaveBeenCalled();

      resolveStop();
      await vi.waitFor(() => expect(service.disarmStopAlarm).toHaveBeenCalledTimes(1));
    });

    /**
     * An owed stop is the case the alarm exists for, so a stop that never lands
     * must not take the alarm down with it.
     *
     * Mutation seen failing: the same disarm-above-the-await move fails this one
     * with "expected "vi.fn()" to not be called at all, but actually been called
     * 3 times", once per attempt.
     */
    it('leaves the alarm armed when every stop attempt rejects', async () => {
      const service = await loadForegroundService();
      service.setConnectedForegroundServiceDesired(true);
      await vi.waitFor(() => expect(service.displayNotification).toHaveBeenCalledTimes(1));

      service.stopForegroundService.mockRejectedValue(new Error('native stop failed'));
      service.setConnectedForegroundServiceDesired(false);
      await vi.waitFor(() => expect(service.stopForegroundService).toHaveBeenCalledTimes(3));
      await flushMicrotasks();

      expect(service.disarmStopAlarm).not.toHaveBeenCalled();
    });

    /**
     * An alarm armed by a previous process survives that process. Cancelling it
     * at boot keeps it from cold-starting a later process for nothing.
     *
     * Mutation seen failing: pointing the boot sweep at a bare
     * notifee.stopForegroundService() instead of stopConnectedForegroundService()
     * times out with "expected "vi.fn()" to be called 1 times, but got 0 times".
     */
    it('cancels a stale alarm from the boot sweep', async () => {
      const service = await loadForegroundService();

      service.stopOrphanedForegroundServiceAtBoot();

      await vi.waitFor(() => expect(service.disarmStopAlarm).toHaveBeenCalledTimes(1));
      expect(service.armStopAlarm).not.toHaveBeenCalled();
    });

    /**
     * Every start re-arms, so a keepalive that follows an earlier one gets its
     * own full deadline rather than the remainder of the old one. The native
     * side keeps one alarm slot, so re-arming replaces it.
     */
    it('re-arms on every start', async () => {
      const service = await loadForegroundService();

      service.setConnectedForegroundServiceDesired(true);
      await vi.waitFor(() => expect(service.displayNotification).toHaveBeenCalledTimes(1));
      service.setConnectedForegroundServiceDesired(false);
      await vi.waitFor(() => expect(service.disarmStopAlarm).toHaveBeenCalledTimes(1));
      service.setConnectedForegroundServiceDesired(true);
      await vi.waitFor(() => expect(service.displayNotification).toHaveBeenCalledTimes(2));

      expect(service.armStopAlarm).toHaveBeenCalledTimes(2);
    });

    /**
     * The trace-build control arm for the device A/B (connectionTrace.ts). With
     * the switch off the service still starts, and nothing native bounds it,
     * which is exactly the shape that should reproduce MOBILE-3 under a
     * shortened OS budget.
     *
     * Mutation seen failing: dropping the nativeStopAlarmEnabled() gate (arming
     * unconditionally) fails with "expected "vi.fn()" to not be called at all,
     * but actually been called 1 times".
     */
    it('skips the arm, but still starts the service, when the trace-build switch is off', async () => {
      process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE = '1';
      try {
        const service = await loadForegroundService();
        const { setNativeStopAlarmEnabled } = await import('@/devsupport/connectionTrace');
        setNativeStopAlarmEnabled(false);

        service.setConnectedForegroundServiceDesired(true);
        await vi.waitFor(() => expect(service.displayNotification).toHaveBeenCalledTimes(1));

        expect(service.armStopAlarm).not.toHaveBeenCalled();
      } finally {
        delete process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE;
        vi.resetModules();
      }
    });
  });
});
