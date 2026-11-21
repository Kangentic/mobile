package expo.modules.foregroundserviceguard

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS's handle on the native stop alarm and on the stop-settle wait. See ForegroundServiceGuard for
 * why each exists.
 *
 * The alarm calls are SYNCHRONOUS `Function`s, deliberately not `AsyncFunction`. The caller arms
 * immediately before notifee's displayNotification, and a synchronous call returns only once
 * AlarmManager holds the alarm. With an async call the start could land first, leaving a window in
 * which a service exists with no alarm behind it.
 *
 * The settle wait is the opposite case: an `AsyncFunction` in its `Coroutine` form, so it suspends
 * off the main thread (which has to stay free to run the STOP it is waiting for) and without
 * blocking the AsyncFunction queue every other Expo module shares. It is a native wait rather than
 * a JS poll on purpose. React Native stops servicing JS timers once the activity pauses unless a
 * headless task is running (inferred from RN's JavaTimerManager), and the moment this is needed is
 * exactly a background transition with the previous keepalive's headless task just released.
 */
class ForegroundServiceGuardModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ForegroundServiceGuard")

    Function("armStopAlarm") { delayMs: Double ->
      ForegroundServiceGuard.arm(context, delayMs.toLong())
    }

    Function("disarmStopAlarm") {
      ForegroundServiceGuard.disarm(context)
    }

    AsyncFunction("awaitServiceStopped") Coroutine { timeoutMs: Double ->
      ForegroundServiceGuard.awaitNotifeeServiceStopped(context, timeoutMs.toLong())
    }
  }

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()
}
