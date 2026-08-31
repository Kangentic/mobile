// '@expo/config-plugins', not 'expo/config-plugins': the latter subpath does not
// exist in SDK 57. See withAndroidE2eGwpAsanOff.ts for why that distinction
// costs an iOS build rather than a prebuild.
import { AndroidConfig, withAndroidManifest, type ConfigPlugin } from '@expo/config-plugins';

/**
 * Makes a RELEASE build sampleable by `simpleperf`, gated on
 * EXPO_PUBLIC_KANGENTIC_PROFILEABLE.
 *
 * Why this has to exist: every performance rule in this repo says measure on a
 * release build, and then the one tool that can answer "what is burning the
 * CPU" refuses to run on one. `simpleperf record -p <pid>` on a normal release
 * APK fails with
 *
 *   failed to open perf event file for event_type cpu-cycles:u: Permission denied
 *
 * because on a non-rooted device the kernel only exposes perf events for an app
 * that has opted in. `<profileable android:shell="true"/>` is that opt-in, and
 * Google designed it precisely for release builds. Note what it actually opens:
 * `simpleperf` CPU sampling AND Perfetto's heap profiling (heapprofd, the Java
 * heap graph), not stack traces alone. It is narrower than `debuggable`, which
 * would also allow a debugger to attach and the JS heap to be dumped on demand,
 * but "stack traces and nothing else" would understate it.
 *
 * WHY IT IS GATED RATHER THAN ALWAYS ON. The exposure is small but it is not
 * zero: this app's crypto is pure TypeScript on Hermes, so Noise keys and
 * decrypted transcript content live in the JS heap rather than behind a native
 * module, and heap profiling on a paired, end-to-end encrypted client is more
 * than a store build needs to hand to any local shell. The
 * gate keeps it off `production` by construction while making a profileable
 * build one env var away:
 *
 *   EXPO_PUBLIC_KANGENTIC_PROFILEABLE=1 npx expo run:android --variant release --no-bundler
 *   adb shell simpleperf record -p $(adb shell pidof com.kangentic.mobile) \
 *     -g -f 1000 --duration 10 -o /data/local/tmp/perf.data
 *   adb shell simpleperf report -i /data/local/tmp/perf.data --sort dso,symbol
 *
 * Same mechanism as EXPO_PUBLIC_KANGENTIC_E2E and _CRASHTEST: an EXPO_PUBLIC_*
 * value read at config-evaluation time, so it travels only with a build that
 * was dispatched with it set. No eas.json profile sets it.
 *
 * If the team later decides the tradeoff is worth it, dropping the gate makes
 * the shipped build profileable too, which is the configuration Android Studio's
 * own "profileable" builds use. That is a deliberate decision, not a default.
 */
const withAndroidProfileable: ConfigPlugin = (config) => {
  if (process.env.EXPO_PUBLIC_KANGENTIC_PROFILEABLE !== '1') {
    return config;
  }

  return withAndroidManifest(config, (manifestConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifestConfig.modResults);
    // The manifest model types `profileable` loosely, so build the node by hand
    // rather than casting the whole application block.
    const withProfileable = application as typeof application & {
      profileable?: { $: Record<string, string> }[];
    };
    withProfileable.profileable = [{ $: { 'android:shell': 'true' } }];
    return manifestConfig;
  });
};

export default withAndroidProfileable;
