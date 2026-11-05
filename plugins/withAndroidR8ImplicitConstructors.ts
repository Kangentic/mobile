// '@expo/config-plugins', not 'expo/config-plugins': see withAndroidGradleHeap.ts.
import { withGradleProperties, type AndroidConfig, type ConfigPlugin } from '@expo/config-plugins';

type GradleProperties = AndroidConfig.Properties.PropertiesItem[];

export const R8_STRICT_KEEP_RULES_PROPERTY = 'android.r8.strictFullModeForKeepRules';

/**
 * Keeps the default constructor of a class held by a bare `-keep class A`.
 *
 * AGP 9.0 flipped `android.r8.strictFullModeForKeepRules` to true, so that rule no
 * longer implies `-keep class A { <init>(); }`. The rules in this dependency tree
 * were written for the old meaning, and Expo's template does not opt out. Measured
 * on the first SDK 58 release build (2026-11-05, emulator): room-runtime 2.5.0's
 * `-keep class * extends androidx.room.RoomDatabase` left WorkDatabase_Impl with no
 * constructor in mapping.txt, and WorkManager's initializer creates it by
 * reflection, so the app died in androidx.startup.InitializationProvider, before
 * any JS and so before Sentry, with CI and verify-r8-optimization.sh both green.
 *
 * Room is only the one that crashed at launch. ArrayCreatingInputMerger and
 * OverwritingInputMerger lost theirs the same way and would have failed later,
 * inside background work, and EventBus creates AndroidComponentsImpl by reflection
 * from another bare rule. That is why this restores the old meaning for the whole
 * tree rather than adding `{ <init>(); }` to each rule: a list has to be complete
 * to be safe, and the entry it misses fails silently on the background push path,
 * the hardest one here to test.
 *
 * These libraries are as old as they are because of Notifee, which is archived:
 * its build.gradle pins work-runtime 2.8.0, which brings room-runtime 2.5.0, and
 * eventbus 3.3.1. Revisit when Notifee goes, by turning this off and reading a
 * launch and mapping.txt, not by assuming.
 */
export function applyImplicitConstructorKeeps(properties: GradleProperties): GradleProperties {
  const others = properties.filter((item) => !(item.type === 'property' && item.key === R8_STRICT_KEEP_RULES_PROPERTY));
  return [...others, { type: 'property', key: R8_STRICT_KEEP_RULES_PROPERTY, value: 'false' }];
}

const withAndroidR8ImplicitConstructors: ConfigPlugin = (config) =>
  withGradleProperties(config, (propertiesConfig) => {
    propertiesConfig.modResults = applyImplicitConstructorKeeps(propertiesConfig.modResults);
    return propertiesConfig;
  });

export default withAndroidR8ImplicitConstructors;
