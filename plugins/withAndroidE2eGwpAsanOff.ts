// '@expo/config-plugins', not 'expo/config-plugins': the latter subpath does not
// exist in SDK 57, and while `expo prebuild` resolves it anyway through Expo
// CLI's own loader, `eas build` imports this file as plain Node ESM and strictly
// honours package exports. See withAndroidPushService.ts, where that difference
// cost an iOS build while every prebuild gate stayed green.
import { AndroidConfig, withAndroidManifest, type ConfigPlugin } from '@expo/config-plugins';

/**
 * E2E BUILDS ONLY. Turns GWP-ASan off for the `e2e` profile's APK.
 *
 * GWP-ASan is Android's sampling heap-bug detector, on by default for
 * `userdebug` system images, which is what the CI emulator runs
 * (`api-level: 34`, `target: default` in .github/workflows/e2e.yml). On run
 * 30308333829 it took the app down 838ms after `launchApp`:
 *
 *   F/libc: Fatal signal 11 (SIGSEGV), code 2 (SEGV_ACCERR), fault addr 0x78e264c3a000
 *   #00 android_unsafe_frame_pointer_chase
 *   #01 gwp_asan::AllocationMetadata::CallSiteInfo::RecordBacktrace
 *   #02 gwp_asan::GuardedPoolAllocator::deallocate
 *   #03..#11 libhermesvm.so
 *   #12 hoost_make_fcontext                                  libhermesvm.so
 *
 * The frame-pointer walk ran off the end of a Hermes `fcontext` JS stack, which
 * is mmap'd separately from the thread stack, into a guard page: `rcx` and `r12`
 * both held exactly `fault_addr - 8`.
 *
 * TWO THINGS THIS IS NOT.
 *
 * It is not a detection, so nothing is being suppressed. `deallocate` calling
 * `RecordBacktrace` is routine bookkeeping recording where a guarded allocation
 * was freed, not the error-reporting path, and no "GWP-ASan detected a memory
 * error" report appears anywhere in the run's artifacts. The instrumentation
 * crashed doing its own housekeeping; nothing about our code was flagged.
 *
 * It is not a fix for one flaky flow. Every flow under .maestro/paired/ opens
 * with `launchApp`, and GWP-ASan samples per process, so the next occurrence
 * lands on whichever flow happens to draw the sample. It presented as
 * `session-respawn-recovery` failing an `assertVisible`, which reads exactly
 * like a product regression and sent one investigation looking at feed state
 * and stub redial timing before the tombstone was found.
 *
 * SCOPE. Gated on EXPO_PUBLIC_KANGENTIC_E2E, the same build-time flag as the
 * `usesCleartextTraffic` carve-out in app.config.ts and the relay-address
 * carve-out in src/pairing/qr.ts. EXPO_PUBLIC_* values are read at
 * config-evaluation time and the `e2e` profile is the only one in eas.json that
 * sets it, so this travels with the E2E APK and cannot reach `preview` or
 * `production`. Whether shipping builds want the same opt-out is a SEPARATE
 * question: it turns on whether the `user`-build default matches the
 * `userdebug` one, which is unverified, so nothing here presumes an answer.
 */
const withAndroidE2eGwpAsanOff: ConfigPlugin = (config) => {
  if (process.env.EXPO_PUBLIC_KANGENTIC_E2E !== '1') {
    return config;
  }

  return withAndroidManifest(config, (manifestConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifestConfig.modResults);
    application.$['android:gwpAsanMode'] = 'never';
    return manifestConfig;
  });
};

export default withAndroidE2eGwpAsanOff;
