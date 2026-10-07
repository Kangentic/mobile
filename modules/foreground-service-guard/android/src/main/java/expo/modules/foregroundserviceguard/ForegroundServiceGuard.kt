package expo.modules.foregroundserviceguard

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log

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
 * ("did not then call Service.startForeground()"). In the app's own flow every start is
 * serialized behind a JS stop that resolves the runner, so that is a path this avoids, not one
 * observed. The STOP intent makes this receiver correct on its own, whatever JS later does. It is
 * the same intent notifee's own `stop()` sends, with the same `stopService` fallback when Android
 * refuses a background `startService`.
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
