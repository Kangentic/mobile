// '@expo/config-plugins', not 'expo/config-plugins'. The latter subpath does not
// exist in SDK 57; see the comment in withAndroidPushService.ts for what that
// cost.
import { withSettingsGradle, type ConfigPlugin } from '@expo/config-plugins';

/**
 * Makes local Android builds work from ANY checkout path on Windows, including
 * a Kangentic task worktree.
 *
 * TWO MECHANISMS, both MAX_PATH, and neither is the one this problem was
 * assumed to have for months.
 *
 * 1. Ninja stats the prefab config through a `..`. The file exists, but ninja
 *    resolves it relative to the build directory and Windows applies MAX_PATH to
 *    the composed string BEFORE collapsing the `..`:
 *
 *      ninja explain: output ../prefab/arm64-v8a/prefab/lib/aarch64-linux-android/
 *      cmake/react-native-worklets/react-native-workletsConfigVersion.cmake of
 *      phony edge with no inputs doesn't exist
 *
 *    The stat fails, ninja re-runs CMake, CMake regenerates identically, and it
 *    ends at `ninja: error: manifest 'build.ninja' still dirty after 100 tries`,
 *    naming nothing at all. The binding module is `react-native-reanimated`,
 *    through the `react-native-worklets` prefab package (a 121-character
 *    relative path, against 96 for `ReactAndroid`).
 *
 * 2. CMake abandons hashing and emits the full mangled name. Only visible once
 *    the first is cleared. CMake hashes leading path components when an object
 *    path exceeds CMAKE_OBJECT_PATH_MAX (default 250), but when even its fully
 *    hashed floor exceeds that, it gives up and emits the UNSHORTENED name:
 *
 *      ninja: error: Stat(EnrichedMarkdownTextSpec_autolinked_build/CMakeFiles/
 *      react_codegen_EnrichedMarkdownTextSpec.dir/C_/Users/.../
 *      ComponentDescriptors.cpp.o): Filename longer than 260 characters
 *
 *    Raising the limit to 1000 is exactly backwards, and was tested: it tells
 *    CMake never to shorten, warnings went 402 to 0, and the build failed
 *    identically. 259 is the real ceiling (MAX_PATH counts the terminating NUL).
 *
 * Relocating the staging directory fixes the first and shrinks the second's
 * floor at the same time, because everything after `CMakeFiles/<target>.dir/`
 * is hashable and everything before it now lives at a fixed short root. That is
 * why this works at any depth rather than buying a fixed number of characters.
 *
 * WHY settings.gradle AND NOT a root `subprojects {}` BLOCK. AGP reads
 * `buildStagingDirectory` during each module's own evaluation, so a root block
 * throws `It is too late to set buildStagingDirectory`. A root block also never
 * reaches `:app` at all, which presents as a build that still fails with an
 * unchanged `.cxx` config hash and `FLAG ABSENT` in
 * `metadata_generation_command.txt`. `gradle.beforeProject` plus
 * `plugins.withId` lands inside each module's evaluation, which is the only
 * window where both settings are accepted.
 *
 * CNG: this is how `android/` gets native config (.claude/rules/expo-cng.md).
 * The generated project is never hand-edited and never committed.
 */

/**
 * Idempotency anchor. `expo prebuild` regenerates `settings.gradle` from the
 * template on a clean run but merges into the existing file otherwise, so the
 * block has to be able to recognise itself.
 */
export const CMAKE_BUILD_STAGING_ANCHOR = '// kangentic:cmake-build-staging';

/**
 * Windows MAX_PATH is 260 INCLUDING the terminating NUL, so 259 is the longest
 * usable path and the highest value that still asks CMake to shorten.
 */
export const CMAKE_OBJECT_PATH_MAX = 259;

/** Overrides the derived staging root, for a machine where the default will not do. */
export const STAGING_ROOT_ENVIRONMENT_VARIABLE = 'KANGENTIC_CMAKE_STAGING_ROOT';

/**
 * Staging root when the environment variable is unset.
 *
 * Derived from the system drive rather than hardcoding `C:`, which would be
 * wrong on a machine that boots from another letter. Kept deliberately short:
 * every character here is spent one-for-one against the 259 ceiling. Measured
 * against the 646 object files a proven build left on disk, the worst hash
 * floor at a 15-character prefix is 214, so this 21-character prefix leaves
 * roughly 30 characters of headroom for a debug build and 21 for a release one
 * (AGP names the release variant directory `RelWithDebInfo`, 9 characters
 * longer than `Debug`).
 *
 * `%LOCALAPPDATA%` was rejected on that measurement, not on taste: it costs 37
 * more characters, which puts a release build's floor at 260, and its length
 * varies with the user's name so it would fail for some contributors only.
 *
 * Mirrored in scripts/cmakeStaging.mjs, and
 * tests/unit/androidCmakeBuildStaging.test.ts asserts the two agree so they
 * cannot drift.
 */
export function defaultStagingRoot(systemDrive: string | undefined): string {
  return `${systemDrive || 'C:'}/kangentic/android`;
}

/**
 * The system drive, as a Groovy expression, in the form `defaultStagingRoot`
 * takes.
 *
 * The block builds its root by passing this THROUGH `defaultStagingRoot` rather
 * than inlining the path a third time. That is what makes the drift test
 * load-bearing: the generated Groovy is the copy that actually decides where the
 * build writes, so a test pinning only the TypeScript and the script would agree
 * with itself while `verify:staging` walked an empty directory.
 */
const GROOVY_SYSTEM_DRIVE = `\${System.getenv('SystemDrive') ?: 'C:'}`;

/**
 * The Groovy appended to `android/settings.gradle`.
 *
 * WINDOWS-ONLY IS DECIDED HERE, NOT IN THE PLUGIN. Gating in TypeScript would
 * make the generated project differ per platform and would leave the Linux CI
 * runner able to verify nothing but the no-op. Gating in Groovy keeps prebuild
 * output identical everywhere, so `ci.yml`'s Native config job can assert the
 * block actually landed, which is the failure mode an anchor-guarded append
 * really has.
 *
 * The checkout hash is per checkout so parallel Kangentic worktrees never write
 * the same object files. It is computed at script level because `settingsDir`
 * exists only there, and with `def` because a closure defined in the same
 * script captures a script local. Bare assignment is NOT an alternative here:
 * `Settings` has no dynamic property bag, so it throws `No such property`.
 */
export const CMAKE_BUILD_STAGING_BLOCK = `${CMAKE_BUILD_STAGING_ANCHOR}
//
// Relocates every module's CMake staging directory (AGP's .cxx) to a short
// absolute root and raises CMAKE_OBJECT_PATH_MAX to the real Windows ceiling,
// so a build works from any checkout depth. Generated by
// plugins/withAndroidCmakeBuildStaging.ts, which carries the full reasoning.
// Do not hand-edit: android/ is a prebuild artifact.
def kangenticCheckoutId = java.security.MessageDigest.getInstance('SHA-256')
  .digest(settingsDir.canonicalPath.toLowerCase().bytes)
  .encodeHex().toString().take(8)

gradle.beforeProject { project ->
  // The whole problem is absent on macOS and Linux, so leave those builds alone.
  if (!System.getProperty('os.name').toLowerCase().startsWith('windows')) {
    return
  }

  def stagingRoot = System.getenv('${STAGING_ROOT_ENVIRONMENT_VARIABLE}') ?:
    "${defaultStagingRoot(GROOVY_SYSTEM_DRIVE)}"

  ['com.android.library', 'com.android.application'].each { pluginId ->
    project.plugins.withId(pluginId) {
      // Call form, not assignment: assigning would clobber the arguments
      // expo-build-properties and React Native already set.
      project.android.defaultConfig.externalNativeBuild.cmake.arguments '-DCMAKE_OBJECT_PATH_MAX=${CMAKE_OBJECT_PATH_MAX}'
      project.android.externalNativeBuild.cmake.buildStagingDirectory =
        new File("\${stagingRoot}/\${kangenticCheckoutId}/\${project.name}")
    }
  }
}`;

/**
 * Appends the block unless it is already present.
 *
 * Returns `contents` untouched on a second application rather than throwing:
 * re-running prebuild over an existing `android/` is routine, and the anchor is
 * how the block recognises itself.
 */
export function applyCmakeBuildStaging(contents: string): string {
  if (contents.includes(CMAKE_BUILD_STAGING_ANCHOR)) {
    return contents;
  }
  return `${contents.trimEnd()}\n\n${CMAKE_BUILD_STAGING_BLOCK}\n`;
}

const withAndroidCmakeBuildStaging: ConfigPlugin = (config) => {
  return withSettingsGradle(config, (settingsConfig) => {
    // Throws rather than no-opping. A Kotlin-DSL settings file would silently
    // receive Groovy and fail at configure time with a syntax error that names
    // the generated file rather than this plugin, which is the expensive way to
    // find out. This project is Groovy today; the check exists so a template
    // change upstream cannot turn the fix off quietly.
    if (settingsConfig.modResults.language !== 'groovy') {
      throw new Error(
        `withAndroidCmakeBuildStaging expects a Groovy settings.gradle, got '${settingsConfig.modResults.language}'. ` +
          'The appended block is Groovy; port it before enabling the Kotlin DSL.'
      );
    }

    settingsConfig.modResults.contents = applyCmakeBuildStaging(settingsConfig.modResults.contents);
    return settingsConfig;
  });
};

export default withAndroidCmakeBuildStaging;
