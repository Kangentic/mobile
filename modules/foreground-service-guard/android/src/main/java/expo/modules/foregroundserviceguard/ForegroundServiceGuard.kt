package expo.modules.foregroundserviceguard

import android.app.ActivityManager
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import kotlinx.coroutines.delay

/**
 * A native deadline on notifee's `dataSync` foreground service, for when JS cannot stop it.
 *
 * WHY THIS EXISTS (Sentry MOBILE-3). Android 15+ gives a `dataSync` foreground service a 6h
 * budget and kills the process with `ForegroundServiceDidNotStopInTimeException` when it runs
 * over. The app's own bound is a five-minute ceiling in JS (connectionManager.ts), enforced by a
 * timer and by a wall-clock check on wake sources that reach JS. Build 13 shipped all of that and
 * still crashed. The wake sources go away together: no rekey once the channel is gone, no
 * AppState transition while the user stays away, no boot sweep while the process lives. When JS
 * stops running, nothing in JS can stop the service.
 *
 * notifee 9.1.8 cannot help. `app.notifee.core.ForegroundService` ships inside a prebuilt AAR with
 * no `onTimeout` override, and upstream main has none either. So this alarm is the bound that
 * does not depend on the JS thread. JS arms it immediately before every service start and
 * cancels it once a stop has been issued. If it fires, the receiver stops the service from
 * native code on the main thread.
 *
 * THE STOP GOES THROUGH NOTIFEE'S OWN STOP ACTION, NOT A BARE `stopService`. Read from the
 * 9.1.8 bytecode (`javap` on the AAR's classes.jar): `onStartCommand` keeps the current
 * notification id in a STATIC field and skips `startForeground` whenever that static is set and
 * the service type is unchanged, posting a plain `notify()` instead. Two things clear it: the
 * STOP branch, and notifee's completion callback when the JS runner promise resolves. A bare
 * `stopService` does neither, so the static stays set until JS next runs a stop. If a start ever
 * arrived before that, it would skip `startForeground`, and Android kills the app for that too
 * ("did not then call Service.startForeground()"). The STOP intent makes this receiver correct on
 * its own, whatever JS later does. It is the same intent notifee's own `stop()` sends, with the
 * same `stopService` fallback when Android refuses a background `startService`.
 *
 * That stale-static path is still one this avoids rather than one observed. This header used to
 * say why it was avoided: "every start is serialized behind a JS stop that resolves the runner".
 * That was true of the stop's SEND and nothing more, and Sentry MOBILE-J (1.5.1+22) is the same
 * exception arriving by the other door. notifee's STOP branch calls `stopSelf()` with no start id,
 * which AOSP's `stopServiceTokenLocked` treats as unconditional, and `stopForegroundService`
 * resolves once the STOP intent is SENT, not once it has run. So a start that JS issued straight
 * after a stop reached the system while that STOP was still queued on the main thread, the STOP's
 * `stopSelf()` then tore the service down with the start's `startForeground` still owed, and
 * `bringDownServiceLocked` crashed the app for it. The trigger was a notification tap that
 * resumed and paused the activity twice in about 80 ms. `awaitNotifeeServiceStopped` below is the
 * repair: JS waits for it before any start that follows a stop, so a STOP has always run, and
 * cleared the static, before the next start exists. docs/architecture.md has the evidence.
 */
object ForegroundServiceGuard {
  private const val TAG = "KangenticFgsGuard"

  /**
   * notifee's service and its stop action, as strings rather than a class literal so this
   * module has no compile-time dependency on notifee's AAR. The class name must equal
   * NOTIFEE_FOREGROUND_SERVICE in plugins/withAndroidPushService.ts, and both literals are
   * pinned by tests/unit/foregroundServiceGuard.test.ts against a notifee version check,
   * since no JS test tier can load this file.
   */
  private const val NOTIFEE_FOREGROUND_SERVICE = "app.notifee.core.ForegroundService"
  private const val NOTIFEE_STOP_ACTION = "app.notifee.core.ForegroundService.STOP"

  /**
   * One fixed slot: re-arming replaces the pending alarm and disarming cancels the same one.
   * The value is ASCII "FGSG", chosen only to be recognizable in `dumpsys alarm`.
   */
  private const val REQUEST_CODE = 0x46475347

  /**
   * How often awaitNotifeeServiceStopped asks whether the service is gone. About one frame: a
   * STOP normally runs within a few of them, and each poll is one binder call.
   */
  private const val SETTLE_POLL_INTERVAL_MS = 16L

  /**
   * ELAPSED_REALTIME_WAKEUP counts deep sleep and wakes the device. The FGS budget accrues on
   * uptime, which does not, so an alarm on elapsed realtime always fires before the budget can
   * run out. Inexact `setAndAllowWhileIdle` needs no exact-alarm permission (denied by default
   * from Android 14) and still fires in Doze. Inexact means "not before, possibly somewhat
   * after", so the delay must sit above the JS ceiling and far below 6h.
   */
  fun arm(context: Context, delayMs: Long) {
    val alarmManager = context.getSystemService(AlarmManager::class.java) ?: return
    alarmManager.setAndAllowWhileIdle(
      AlarmManager.ELAPSED_REALTIME_WAKEUP,
      SystemClock.elapsedRealtime() + delayMs,
      alarmIntent(context),
    )
  }

  fun disarm(context: Context) {
    val alarmManager = context.getSystemService(AlarmManager::class.java) ?: return
    alarmManager.cancel(alarmIntent(context))
  }

  /**
   * Mirrors notifee's `ForegroundService.stop()`. While the service is still foreground the app
   * counts as foreground for background-start limits, so `startService` is allowed and reaches
   * `onStartCommand`'s STOP branch (stopSelf plus clearing the statics). If Android refuses a
   * background start, the service is already no longer foreground, and `stopService` finishes
   * it. Delivering STOP to a service that is not running starts it only to stop it at once.
   */
  fun stopNotifeeService(context: Context) {
    val stopIntent = Intent()
      .setComponent(ComponentName(context.packageName, NOTIFEE_FOREGROUND_SERVICE))
      .setAction(NOTIFEE_STOP_ACTION)
    try {
      context.startService(stopIntent)
      Log.i(TAG, "stop alarm fired; notifee stop action sent")
    } catch (illegalState: IllegalStateException) {
      context.stopService(stopIntent)
      Log.i(TAG, "stop alarm fired; background start refused, stopService sent")
    } catch (exception: Exception) {
      Log.w(TAG, "stop alarm fired; stop failed", exception)
    }
  }

  /**
   * Whether notifee's service has a record in the system right now: running, being created, or
   * holding a STOP that has not run yet. Read from AOSP's `ActiveServices`: `getRunningServices`
   * lists the caller's own records out of `mServicesByInstanceName`, and `bringDownServiceLocked`
   * removes a record from that map. So "absent" means any STOP sent earlier has already run.
   *
   * `getRunningServices` is deprecated since API 26 for reading OTHER apps' services. It still
   * returns the caller's own, which is the only thing asked of it here.
   */
  @Suppress("DEPRECATION")
  fun isNotifeeServiceRunning(context: Context): Boolean {
    val activityManager = context.getSystemService(ActivityManager::class.java) ?: return false
    return activityManager.getRunningServices(Int.MAX_VALUE).any { serviceInfo ->
      serviceInfo.service.packageName == context.packageName &&
        serviceInfo.service.className == NOTIFEE_FOREGROUND_SERVICE
    }
  }

  /**
   * Suspends until notifee's service has no record, or `timeoutMs` passes. True means it is gone.
   *
   * A SUSPENDING poll, never a blocking one and never on the main thread. The main thread is what
   * runs the STOP this waits for, so polling there would wait on itself. And the module's
   * AsyncFunction queue is ONE HandlerThread shared by every Expo module, so a blocking sleep
   * would stall all of their async calls for as long as it waited. `delay` releases it.
   */
  suspend fun awaitNotifeeServiceStopped(context: Context, timeoutMs: Long): Boolean {
    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    while (true) {
      if (!isNotifeeServiceRunning(context)) return true
      if (SystemClock.elapsedRealtime() >= deadline) return false
      delay(SETTLE_POLL_INTERVAL_MS)
    }
  }

  private fun alarmIntent(context: Context): PendingIntent {
    val intent = Intent(context, ForegroundServiceGuardReceiver::class.java)
    return PendingIntent.getBroadcast(
      context,
      REQUEST_CODE,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }
}
