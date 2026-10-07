package expo.modules.foregroundserviceguard

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS's handle on the native stop alarm. See ForegroundServiceGuard for why it exists.
 *
 * SYNCHRONOUS `Function`s, deliberately not `AsyncFunction`. The caller arms immediately before
 * notifee's displayNotification, and a synchronous call returns only once AlarmManager holds the
 * alarm. With an async call the start could land first, leaving a window in which a service
 * exists with no alarm behind it.
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
  }

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()
}
