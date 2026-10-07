package expo.modules.foregroundserviceguard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Receives the stop alarm. This runs on the main thread with no JS involvement. That
 * independence is the whole point: the alarm exists for the case where the JS thread is
 * not running the app's own ceiling. If the process died since the alarm was armed,
 * Android starts it to deliver this broadcast, and the stop is then a no-op.
 */
class ForegroundServiceGuardReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    ForegroundServiceGuard.stopNotifeeService(context)
  }
}
