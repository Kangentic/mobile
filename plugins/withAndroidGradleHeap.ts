// '@expo/config-plugins', not 'expo/config-plugins': the latter subpath does not
// exist in SDK 57, and while `expo prebuild` resolves it anyway through Expo
// CLI's own loader, `eas build` imports this file as plain Node ESM and strictly
// honours package exports. See withAndroidPushService.ts, where that difference
// cost an iOS build while every prebuild gate stayed green.
import { withGradleProperties, type ConfigPlugin } from '@expo/config-plugins';

/**
 * Raises the Gradle daemon heap so R8 survives a production build.
 *
 * The Expo template writes `org.gradle.jvmargs=-Xmx2048m
 * -XX:MaxMetaspaceSize=512m` into the generated android/gradle.properties, and
 * nothing in this repo ever raised it. That cap held until the first
 * production build after R8 minification was enabled (enableMinifyInReleaseBuilds
 * in app.config.ts, 2026-07-30): run 30863026481, the v0.3.0 release, died at
 * 24 minutes with
 *
 *   ERROR: R8: java.lang.OutOfMemoryError: Java heap space
 *   > Task :app:minifyReleaseWithR8 FAILED
 *   > Task :app:configureCMakeRelWithDebInfo[x86] FAILED
 *   * What went wrong: Some project locks have not been unlocked.
 *
 * The lock message is fallout, not a second bug: R8 runs inside the Gradle
 * daemon, so its OOM took the daemon down mid-flight and the concurrent x86
 * CMake configure died holding its lock. The preview and e2e release builds
 * kept passing at 2048m because they build fewer ABIs; the production AAB runs
 * all four ABIs' externalNativeBuild bookkeeping in the same daemon that R8
 * shares, and that tipped it over.
 *
 * Why not CI-only (a GRADLE_OPTS line in build-android.yml): -Xmx is a cap, not
 * a reservation, so a machine's physical RAM never lifts it. A local release
 * build (the /e2e rig rebuilds one when the APK is stale) hits the identical
 * 2048m ceiling on any hardware, so the fix belongs to the project, not to the
 * runner. The GitHub ubuntu runners have 16 GB and a developer machine that can
 * run the Android emulator has at least that, so 4096m is comfortably inside
 * both.
 */
const GRADLE_JVM_ARGS = '-Xmx4096m -XX:MaxMetaspaceSize=1024m';

const withAndroidGradleHeap: ConfigPlugin = (config) => {
  return withGradleProperties(config, (propertiesConfig) => {
    propertiesConfig.modResults = propertiesConfig.modResults.filter(
      (item) => !(item.type === 'property' && item.key === 'org.gradle.jvmargs'),
    );
    propertiesConfig.modResults.push({
      type: 'property',
      key: 'org.gradle.jvmargs',
      value: GRADLE_JVM_ARGS,
    });
    return propertiesConfig;
  });
};

export default withAndroidGradleHeap;
