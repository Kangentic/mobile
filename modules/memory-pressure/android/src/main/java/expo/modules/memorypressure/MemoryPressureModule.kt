package expo.modules.memorypressure

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Surfaces Android's `onTrimMemory` to JavaScript, which React Native does not.
 *
 * WHY THIS EXISTS. `AppState`'s `memoryWarning` event is iOS-only in practice:
 * `RCTAppState.mm` observes `UIApplicationDidReceiveMemoryWarning`, while the
 * Android `AppStateModule` never emits that event at all. Android's equivalent
 * signal is `ComponentCallbacks2.onTrimMemory`, and nothing in React Native
 * forwards it. So before this module the app was blind to memory pressure on
 * Android, which is half the fleet and the only half the project can actually
 * measure (see Sentry MOBILE-8 and `docs/developer-guide.md`).
 *
 * REGISTERED ON THE APPLICATION CONTEXT, not an Activity. The Activity
 * callbacks stop arriving once no activity is resumed, which is exactly when
 * the background trim levels are delivered - the ones that say the process is
 * next in line to be killed.
 */
class MemoryPressureModule : Module() {
  private var callbacks: ComponentCallbacks2? = null

  override fun definition() = ModuleDefinition {
    Name("MemoryPressure")

    Events(ON_MEMORY_PRESSURE)

    OnCreate {
      val applicationContext = appContext.reactContext?.applicationContext ?: return@OnCreate
      val registered = object : ComponentCallbacks2 {
        override fun onTrimMemory(level: Int) {
          emitIfPressure(level)
        }

        override fun onConfigurationChanged(newConfig: Configuration) = Unit

        /**
         * Deprecated since API 34 and never called on a modern device, but a
         * `ComponentCallbacks2` must implement it. Forwarded at the most severe
         * level rather than ignored: where it still fires it means the system
         * is critically short.
         */
        @Deprecated("Deprecated in Java")
        override fun onLowMemory() {
          emit(ON_MEMORY_PRESSURE, mapOf("level" to ComponentCallbacks2.TRIM_MEMORY_COMPLETE))
        }
      }
      applicationContext.registerComponentCallbacks(registered)
      callbacks = registered
    }

    OnDestroy {
      val applicationContext = appContext.reactContext?.applicationContext
      callbacks?.let { applicationContext?.unregisterComponentCallbacks(it) }
      callbacks = null
    }
  }

  /**
   * NOT every trim level is memory pressure, and forwarding the wrong ones
   * would be worse than forwarding none.
   *
   * `TRIM_MEMORY_UI_HIDDEN` (20) arrives on EVERY backgrounding - it means "your
   * UI went away", not "memory is short". Forwarding it would make the app shed
   * transcripts and terminal rings every time the user switches apps, so a
   * returning user re-fetches everything that was just dropped; and it would
   * make the `app.memory` breadcrumb's count mean "the user multitasked"
   * rather than "pressure happened". That second one is the dangerous half: the
   * whole purpose of the breadcrumb is to let the NEXT watchdog-termination
   * event self-identify, and a trail that carries memory warnings either way
   * says exactly as much as the missing signal it replaced, which is nothing.
   *
   * So: the RUNNING_* levels, which are delivered while the app is in the
   * FOREGROUND and are the real analogue of the iOS memory warning, plus
   * MODERATE and COMPLETE, which say the process is far enough down the LRU
   * list to be worth releasing everything reconstructible. `TRIM_MEMORY_BACKGROUND`
   * (40) is deliberately excluded with UI_HIDDEN: it means "on the LRU list",
   * which is the normal resting state of a backgrounded app rather than a
   * signal about memory.
   */
  private fun isPressure(level: Int): Boolean =
    when (level) {
      ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE,
      ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW,
      ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL,
      ComponentCallbacks2.TRIM_MEMORY_MODERATE,
      ComponentCallbacks2.TRIM_MEMORY_COMPLETE -> true
      else -> false
    }

  private fun emitIfPressure(level: Int) {
    if (!isPressure(level)) return
    emit(ON_MEMORY_PRESSURE, mapOf("level" to level))
  }

  private fun emit(eventName: String, body: Map<String, Any?>) {
    runCatching { sendEvent(eventName, body) }
  }

  companion object {
    const val ON_MEMORY_PRESSURE = "onMemoryPressure"
  }
}
