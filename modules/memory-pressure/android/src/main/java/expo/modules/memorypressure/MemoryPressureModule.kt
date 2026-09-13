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

  /**
   * The context the callbacks were actually registered on, held so teardown
   * can unregister against the SAME object it registered with.
   *
   * Re-deriving `appContext.reactContext?.applicationContext` in `OnDestroy`
   * looks equivalent and is not: `reactContext` can already be null by the
   * time a module is destroyed, which is the ordinary case on a dev-client
   * reload. The unregister would then silently not happen while `callbacks`
   * was nulled out, stranding a `ComponentCallbacks2` on the Application
   * object - the one thing here that outlives the React context - with no JS
   * reference left to remove it. Every reload would leak another, each still
   * firing into a destroyed module, and `emit`'s `runCatching` would hide it.
   */
  private var registeredContext: Context? = null

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
      registeredContext = applicationContext
    }

    OnDestroy {
      callbacks?.let { registeredContext?.unregisterComponentCallbacks(it) }
      callbacks = null
      registeredContext = null
    }
  }

  /**
   * WHICH LEVELS ANDROID ACTUALLY DELIVERS, which is the thing to get right
   * here and which an earlier revision of this module got wrong.
   *
   * **From Android 14 the system delivers only `TRIM_MEMORY_UI_HIDDEN` and
   * `TRIM_MEMORY_BACKGROUND`.** The `RUNNING_*`, `MODERATE` and `COMPLETE`
   * constants are no longer sent, and were formally deprecated in Android 15
   * (developer.android.com/topic/performance/memory/manage-app-memory). This
   * module originally forwarded ONLY those legacy constants and deliberately
   * excluded the two that still arrive, which made it inert on every modern
   * device while appearing to work.
   *
   * It appeared to work because `adb shell am send-trim-memory` INJECTS a level
   * through `setProcessMemoryTrimLevel`, bypassing the system's delivery
   * policy. That proves the callback plumbing, not that the OS ever sends the
   * level. Verifying a signal by injecting it is exactly the kind of false
   * confidence `.claude/rules/performance-claims-are-measured.md` exists to
   * prevent, and it is why this comment names the source rather than the test.
   *
   * The two that survive are not interchangeable with the old ones, so the
   * distinction is pushed to JS as a severity rather than flattened here:
   * `UI_HIDDEN` and `BACKGROUND` mean "the user is not looking, release what is
   * reconstructible", while the legacy `RUNNING_*` levels meant "memory is
   * short RIGHT NOW, in the foreground". Only the second kind is evidence for
   * the Sentry MOBILE-8 diagnostic; counting an ordinary backgrounding as a
   * memory warning would make the breadcrumb's count mean "the user
   * multitasked" and say exactly as much as the missing signal it replaced,
   * which is nothing.
   *
   * THE OTHER HALF OF THIS TABLE LIVES IN JS, and changing this filter without
   * it is the silent way to break the feature. `severityForTrimLevel` in
   * `src/observability/memoryPressure.ts` re-spells three of these constants by
   * VALUE - `TRIM_MEMORY_RUNNING_MODERATE` (5), `TRIM_MEMORY_UI_HIDDEN` (20)
   * and `TRIM_MEMORY_BACKGROUND` (40) - and classifies everything else this
   * module forwards as `serious`. So widening the set below hands JS a level it
   * will silently call `serious`, and narrowing it makes a branch there dead.
   * Nothing mechanical connects the two: no JS tier can load Kotlin, which is
   * why the correspondence is a grep away in both directions and checked by
   * hand on device (`am send-trim-memory`; see docs/developer-guide.md).
   *
   * Observed while establishing the above, and worth keeping because it shapes
   * how anyone tests this: `am send-trim-memory` REFUSES the four background
   * levels against a foreground process with `IllegalArgumentException: Unable
   * to set a background trim level on a foreground process`, and **this app
   * counts as foreground even behind the launcher** because it runs a
   * foreground service for background notifications (`dumpsys activity
   * processes` shows `fg +50 F/S/FGS (fg-service-act)` with the launcher
   * focused). So pressing HOME delivers nothing while that service runs. Turn
   * background notifications off before concluding the module is broken.
   */
  private fun isPressure(level: Int): Boolean =
    when (level) {
      // Still delivered on every API level, and the ONLY two delivered from
      // Android 14 on. See the note above about the legacy constants.
      ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN,
      ComponentCallbacks2.TRIM_MEMORY_BACKGROUND,
      // Legacy, and dead weight on Android 14+. Kept because minSdk is 24 and
      // these are the only real PRESSURE signal an older device gives.
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
