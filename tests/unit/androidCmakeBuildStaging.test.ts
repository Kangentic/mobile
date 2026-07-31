/**
 * The CMake staging relocation, which is what lets a local Android build
 * succeed from a Kangentic task worktree at any path depth.
 *
 * WHY THESE ASSERTIONS AND NOT A `.cxx/**` SCAN. The task this came from asked
 * for a test that every `metadata_generation_command.txt` carries the flag.
 * That tree only exists after a real Windows Gradle build: the unit tier runs on
 * ubuntu-latest with no `android/` checked out at all, and the one CI job that
 * does prebuild never invokes Gradle, so such a scan would match zero files and
 * pass having looked at nothing. It also stopped being a `.cxx/**` glob at all,
 * since the whole point is that the directory now lives outside the project.
 *
 * So the assertion is split three ways, each where it can actually run:
 *   1. here, over the Groovy this plugin generates;
 *   2. ci.yml's Native config job, grepping the real prebuilt settings.gradle;
 *   3. `npm run verify:staging`, over a real build's output, run by hand.
 *
 * Only the third proves the flag reached CMake. These two prove it reached the
 * file, which is the failure an anchor-guarded append actually has.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExpoConfig } from 'expo/config';
import type { ExportedConfig } from '@expo/config-plugins';

import withAndroidCmakeBuildStaging, {
  applyCmakeBuildStaging,
  CMAKE_BUILD_STAGING_ANCHOR,
  CMAKE_BUILD_STAGING_BLOCK,
  CMAKE_OBJECT_PATH_MAX,
  defaultStagingRoot,
} from '../../plugins/withAndroidCmakeBuildStaging';
import {
  classifyStagingTree,
  defaultStagingRoot as defaultStagingRootFromScript,
  REQUIRED_CMAKE_ARGUMENT,
  verify,
} from '../../scripts/cmakeStaging.mjs';

/**
 * A real `android/settings.gradle` as `expo prebuild` generates it for this app.
 * Copied verbatim rather than minimised, so an upstream template change that
 * would break the append shows up here.
 */
const GENERATED_SETTINGS_GRADLE = `pluginManagement {
  def reactNativeGradlePlugin = new File(
    providers.exec {
      workingDir(rootDir)
      commandLine("node", "--print", "require.resolve('@react-native/gradle-plugin/package.json', { paths: [require.resolve('react-native/package.json')] })")
    }.standardOutput.asText.get().trim()
  ).getParentFile().absolutePath
  includeBuild(reactNativeGradlePlugin)
}

plugins {
  id("com.facebook.react.settings")
  id("expo-autolinking-settings")
}

expoAutolinking.useExpoModules()

rootProject.name = 'Kangentic'

expoAutolinking.useExpoVersionCatalog()

include ':app'
includeBuild(expoAutolinking.reactNativeGradlePlugin)
`;

/**
 * The block with every whole-line `//` comment removed.
 *
 * Needed for the same reason buildWorkflow.test.ts strips them: this repository
 * explains its decisions IN the file, and the block's own header names
 * `CMAKE_OBJECT_PATH_MAX`, `.cxx` and Windows in prose. A naive `toContain`
 * would stay green with the real settings deleted and only the comment left.
 *
 * The anchor is itself a comment, so anchor assertions deliberately run against
 * the raw text instead.
 */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe('the generated Gradle block', () => {
  const executable = withoutComments(CMAKE_BUILD_STAGING_BLOCK);

  it('has code left after comments are stripped (guards every assertion below)', () => {
    // Without this, a block that became all-comment would satisfy each
    // `not.toMatch` below by containing nothing at all.
    expect(executable).toMatch(/gradle\.beforeProject/);
    expect(executable.trim().length).toBeGreaterThan(200);
  });

  it('raises the object-path cap to the real Windows ceiling', () => {
    // 259, not 250 and emphatically not 1000. Raising it to 1000 tells CMake
    // never to shorten, which was tested: warnings went 402 to 0 and the build
    // failed identically.
    expect(CMAKE_OBJECT_PATH_MAX).toBe(259);
    expect(executable).toContain(`-DCMAKE_OBJECT_PATH_MAX=${CMAKE_OBJECT_PATH_MAX}`);
  });

  it('appends the cmake argument rather than assigning over it', () => {
    // `arguments '...'` is the appending call form. `arguments = [...]` would
    // clobber what expo-build-properties and React Native already set.
    expect(executable).toMatch(/cmake\.arguments '-DCMAKE_OBJECT_PATH_MAX=/);
    expect(executable).not.toMatch(/cmake\.arguments\s*=/);
  });

  it('sets the staging directory from inside each module evaluation', () => {
    // gradle.beforeProject + plugins.withId is the only window where AGP accepts
    // buildStagingDirectory. A root `subprojects {}` block throws "It is too late
    // to set buildStagingDirectory", and never reaches :app at all.
    expect(executable).toMatch(/gradle\.beforeProject/);
    expect(executable).toMatch(/plugins\.withId/);
    expect(executable).toMatch(/buildStagingDirectory\s*=/);
    expect(executable).not.toMatch(/\bsubprojects\b/);
    expect(executable).not.toMatch(/\ballprojects\b/);
  });

  it('covers library modules as well as the app', () => {
    // The binding module is react-native-reanimated, a library. Covering only
    // com.android.application would leave the failure exactly where it was.
    expect(executable).toContain("'com.android.library'");
    expect(executable).toContain("'com.android.application'");
  });

  it('no-ops on anything but Windows, decided in Gradle rather than in the plugin', () => {
    // Gating here instead of on process.platform keeps prebuild output identical
    // on every platform, which is what lets ci.yml verify the block on Linux.
    expect(executable).toMatch(/os\.name.*windows/is);
  });

  it('keys the staging directory per checkout', () => {
    // Kangentic runs parallel worktrees; a shared directory means two builds
    // writing the same object files.
    expect(executable).toMatch(/MessageDigest/);
    expect(executable).toMatch(/settingsDir/);
    expect(executable).toMatch(/\$\{kangenticCheckoutId\}/);
  });

  it('declares the checkout hash with def, the form a same-script closure captures', () => {
    // Bare assignment is not an alternative: Settings has no dynamic property
    // bag, so `kangenticCheckoutId = ...` throws No such property.
    expect(executable).toMatch(/^def kangenticCheckoutId/m);
  });

  it('honours the staging-root override', () => {
    expect(executable).toContain('KANGENTIC_CMAKE_STAGING_ROOT');
    expect(executable).toContain('SystemDrive');
  });

  it('builds its root from defaultStagingRoot, not a third hand-written copy', () => {
    // This block is the copy that decides where the build ACTUALLY writes.
    // Pinning only the exported helper against scripts/cmakeStaging.mjs (below)
    // let those two agree with each other while the generated Gradle kept a
    // different root, which is the exact drift that test claims to prevent:
    // verify:staging would then walk an empty directory and report success.
    //
    // The drive expression is restated here deliberately. An assertion that
    // imported the plugin's own copy would be a tautology.
    const groovySystemDrive = `\${System.getenv('SystemDrive') ?: 'C:'}`;
    expect(executable).toContain(`${groovySystemDrive}/kangentic/android`);
    expect(executable).toContain(defaultStagingRoot(groovySystemDrive));
  });
});

describe('the default staging root', () => {
  it('derives from the system drive rather than hardcoding C:', () => {
    // Hardcoding C: is wrong on a machine that boots from another letter.
    expect(defaultStagingRoot('D:')).toBe('D:/kangentic/android');
  });

  it('falls back to C: when the drive is unset', () => {
    expect(defaultStagingRoot(undefined)).toBe('C:/kangentic/android');
    expect(defaultStagingRoot('')).toBe('C:/kangentic/android');
  });

  it('agrees with the copy in scripts/cmakeStaging.mjs', () => {
    // The two derivations are separate implementations in separate languages of
    // the same path. If they drift, `npm run verify:staging` walks an empty
    // directory and reports success having examined nothing.
    for (const systemDrive of ['C:', 'D:', undefined]) {
      expect(defaultStagingRootFromScript(systemDrive)).toBe(defaultStagingRoot(systemDrive));
    }
  });

  it('agrees with the script on the flag being verified', () => {
    expect(REQUIRED_CMAKE_ARGUMENT).toBe(`-DCMAKE_OBJECT_PATH_MAX=${CMAKE_OBJECT_PATH_MAX}`);
  });

  it('stays short enough to leave headroom under the 259 cap', () => {
    // Measured: the worst CMake hash floor at a 15-character prefix is 214, and
    // the floor grows one-for-one with the prefix. A release build adds 9 more
    // (RelWithDebInfo against Debug). This pins the budget so a later rename
    // cannot quietly spend it.
    const prefixLength = `${defaultStagingRoot('C:')}/a1b2c3f9/`.length;
    const worstFloorAtMeasuredPrefix = 214;
    const measuredPrefixLength = 15;
    const releaseVariantCost = 9;

    const releaseFloor =
      worstFloorAtMeasuredPrefix - measuredPrefixLength + prefixLength + releaseVariantCost;
    expect(releaseFloor).toBeLessThan(CMAKE_OBJECT_PATH_MAX);
  });
});

describe('applyCmakeBuildStaging', () => {
  it('starts from a fixture that does not already carry the block', () => {
    // Non-vacuity guard. Every assertion below is about adding the anchor, so a
    // fixture that already contained it would make them all pass for free.
    expect(GENERATED_SETTINGS_GRADLE).not.toContain(CMAKE_BUILD_STAGING_ANCHOR);
  });

  it('appends the block', () => {
    const result = applyCmakeBuildStaging(GENERATED_SETTINGS_GRADLE);
    expect(result).toContain(CMAKE_BUILD_STAGING_ANCHOR);
    expect(result).toContain(`-DCMAKE_OBJECT_PATH_MAX=${CMAKE_OBJECT_PATH_MAX}`);
  });

  it('preserves everything prebuild generated', () => {
    const result = applyCmakeBuildStaging(GENERATED_SETTINGS_GRADLE);
    expect(result).toContain("rootProject.name = 'Kangentic'");
    expect(result).toContain("include ':app'");
    expect(result).toContain('expoAutolinking.useExpoModules()');
  });

  it('appends AFTER the existing script, so include \':app\' is already declared', () => {
    const result = applyCmakeBuildStaging(GENERATED_SETTINGS_GRADLE);
    expect(result.indexOf(CMAKE_BUILD_STAGING_ANCHOR)).toBeGreaterThan(result.indexOf("include ':app'"));
  });

  it('is idempotent, which is what stops a re-prebuild stacking blocks', () => {
    const once = applyCmakeBuildStaging(GENERATED_SETTINGS_GRADLE);
    const twice = applyCmakeBuildStaging(once);
    expect(twice).toBe(once);
    expect(occurrences(twice, CMAKE_BUILD_STAGING_ANCHOR)).toBe(1);
    expect(occurrences(twice, 'gradle.beforeProject')).toBe(1);
  });

  it('ends with a trailing newline', () => {
    expect(applyCmakeBuildStaging(GENERATED_SETTINGS_GRADLE).endsWith('\n')).toBe(true);
  });
});

/** The shape withSettingsGradle hands its mod, narrowed to what this plugin touches. */
interface SettingsGradleModConfig {
  modResults: { contents: string; language: string; path: string };
}

/** Async because @expo/config-plugins wraps every mod in an async interceptor. */
type SettingsGradleMod = (config: SettingsGradleModConfig) => Promise<SettingsGradleModConfig>;

function baseConfig(): ExpoConfig {
  return { name: 'Kangentic', slug: 'kangentic-mobile' };
}

function registeredSettingsGradleMod(config: ExpoConfig): SettingsGradleMod | undefined {
  // Not object identity: withSettingsGradle MUTATES the config it is given and
  // returns that same object, so toBe(config) is true whether the plugin ran or
  // short-circuited. The registered mod is the only observable difference.
  const mods = (config as ExportedConfig).mods;
  return mods?.android?.settingsGradle as unknown as SettingsGradleMod | undefined;
}

function modConfig(language: string): SettingsGradleModConfig {
  return {
    modResults: { contents: GENERATED_SETTINGS_GRADLE, language, path: 'android/settings.gradle' },
  };
}

describe('withAndroidCmakeBuildStaging', () => {
  it('registers a settings.gradle mod', () => {
    expect(typeof registeredSettingsGradleMod(withAndroidCmakeBuildStaging(baseConfig()))).toBe('function');
  });

  it('registers it unconditionally, on every platform', () => {
    // The Windows gate lives in the Groovy, not here. If this ever became
    // platform-conditional the CI grep would silently start testing the no-op.
    expect(typeof registeredSettingsGradleMod(withAndroidCmakeBuildStaging(baseConfig()))).toBe('function');
    expect(CMAKE_BUILD_STAGING_BLOCK).toMatch(/os\.name/);
  });

  it('writes the block into the generated file', async () => {
    const mod = registeredSettingsGradleMod(withAndroidCmakeBuildStaging(baseConfig()));
    const result = await mod?.(modConfig('groovy'));
    expect(result?.modResults.contents).toContain(CMAKE_BUILD_STAGING_ANCHOR);
  });

  it('throws rather than writing Groovy into a Kotlin DSL settings file', async () => {
    // Fails loudly at prebuild rather than at configure time, where the error
    // would name the generated file instead of this plugin.
    const mod = registeredSettingsGradleMod(withAndroidCmakeBuildStaging(baseConfig()));
    await expect(mod?.(modConfig('kt'))).rejects.toThrow(/Groovy settings\.gradle/);
  });
});

/**
 * ci.yml greps the generated settings.gradle for the anchor and the flag as
 * RAW STRINGS - a shell step cannot import a TypeScript constant. Nothing else
 * ties those copies to the plugin, so renaming the anchor or changing the cap
 * would leave CI asserting a string that no longer exists, and the job would
 * fail claiming the block never landed when in fact only the grep is stale.
 */
describe("ci.yml's staging assertions", () => {
  const ciWorkflow = readFileSync(
    join(fileURLToPath(new URL('../..', import.meta.url)), '.github/workflows/ci.yml'),
    'utf8'
  );

  it('greps for the anchor the plugin actually writes', () => {
    expect(ciWorkflow).toContain(CMAKE_BUILD_STAGING_ANCHOR);
  });

  it('greps for the object-path cap the plugin actually sets', () => {
    expect(ciWorkflow).toContain(`DCMAKE_OBJECT_PATH_MAX=${CMAKE_OBJECT_PATH_MAX}`);
  });

  it('tolerates a zero count when checking the block did not stack', () => {
    // `grep -c` exits 1 on zero matches, so under `set -euo pipefail` an
    // unguarded command substitution aborts the step before its error message
    // prints - losing exactly the failure the check exists to report.
    expect(ciWorkflow).toMatch(/anchors=\$\(grep -c[^)]*\|\| true\)/);
  });
});

/**
 * `npm run clean:staging` deletes directories, so how it decides which tree
 * belongs to which checkout is the one thing here that can destroy work.
 *
 * The staging layout is reproduced on disk rather than mocked, because the fact
 * these pin is a property of the REAL files AGP writes: only the `app` module's
 * `metadata_generation_command.txt` carries `-DPROJECT_ROOT_DIR`. Library
 * modules configure through their own CMakeLists and record nothing.
 */
describe('classifyStagingTree', () => {
  let temporaryRoot: string;
  let stagingTree: string;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'kangentic-staging-'));
    stagingTree = join(temporaryRoot, 'a1b2c3f9');
  });

  afterEach(() => {
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function writeModuleMetadata(moduleName: string, lines: string[]): void {
    const directory = join(stagingTree, moduleName, 'Debug', '43283s31', 'arm64-v8a');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'metadata_generation_command.txt'), `${lines.join('\n')}\n`);
  }

  function writeLiveCheckout(): string {
    const checkout = join(temporaryRoot, 'checkout');
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'package.json'), '{}\n');
    return checkout;
  }

  it('reads past a library module that sorts ahead of app', () => {
    // The regression this exists for. Reading only the FIRST metadata file
    // worked purely because `app` sorts first in directory order; a module
    // named ahead of it made the whole tree classify as unknown, so prune
    // reported "skip" forever and reclaimed nothing.
    const checkout = writeLiveCheckout();
    writeModuleMetadata('aaa-native-lib', ['-DANDROID_ABI=arm64-v8a', '-DANDROID_STL=c++_shared']);
    writeModuleMetadata('app', [`-DPROJECT_ROOT_DIR=${checkout}\\android`]);

    expect(classifyStagingTree(stagingTree)).toEqual({ status: 'live', checkoutPath: checkout });
  });

  it('identifies the checkout from the recorded android/ path, not the tree name', () => {
    const checkout = writeLiveCheckout();
    writeModuleMetadata('app', [`-DPROJECT_ROOT_DIR=${checkout}\\android`]);

    expect(classifyStagingTree(stagingTree)).toEqual({ status: 'live', checkoutPath: checkout });
  });

  it('reports orphaned only when the checkout itself is gone', () => {
    // Keyed on package.json, NOT on the recorded android/ path: android/ is a
    // gitignored artifact that `expo prebuild --clean` removes from a perfectly
    // live checkout, and pruning on its absence would delete a working tree.
    const vanished = join(temporaryRoot, 'deleted-branch');
    writeModuleMetadata('app', [`-DPROJECT_ROOT_DIR=${vanished}\\android`]);

    expect(classifyStagingTree(stagingTree)).toEqual({
      status: 'orphaned',
      checkoutPath: vanished,
    });
  });

  it('refuses to guess when no module recorded a checkout, so prune keeps it', () => {
    // A build that died before CMake configured leaves exactly this. Deleting
    // on absence is the dangerous default, so unknown must mean keep.
    writeModuleMetadata('aaa-native-lib', ['-DANDROID_ABI=arm64-v8a']);

    expect(classifyStagingTree(stagingTree).status).toBe('unknown');
  });

  it('refuses to guess when the tree holds no metadata at all', () => {
    mkdirSync(join(stagingTree, 'app'), { recursive: true });

    expect(classifyStagingTree(stagingTree).status).toBe('unknown');
  });
});

/**
 * `verify` is scoped to ONE checkout, and that scoping is the whole point.
 *
 * The staging root is shared by every worktree on the machine and its trees
 * survive `gradlew clean` by design, so a whole-root scan fails a build that is
 * perfectly correct and names a file from a branch the developer never built.
 */
describe('verify', () => {
  let temporaryRoot: string;
  const originalOverride = process.env.KANGENTIC_CMAKE_STAGING_ROOT;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'kangentic-verify-'));
    process.env.KANGENTIC_CMAKE_STAGING_ROOT = join(temporaryRoot, 'staging');
    // verify reports through the console by design; silence it so a failing
    // expectation stands out instead of scrolling past its own output.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalOverride === undefined) {
      delete process.env.KANGENTIC_CMAKE_STAGING_ROOT;
    } else {
      process.env.KANGENTIC_CMAKE_STAGING_ROOT = originalOverride;
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  /** A live checkout plus the staging tree a build in it would have left. */
  function makeCheckout(name: string, objectPathMax: number): string {
    const checkout = join(temporaryRoot, name);
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'package.json'), '{}\n');

    const appDirectory = join(
      temporaryRoot,
      'staging',
      `tree-${name}`,
      'app',
      'Debug',
      '43283s31',
      'arm64-v8a'
    );
    mkdirSync(appDirectory, { recursive: true });
    writeFileSync(
      join(appDirectory, 'metadata_generation_command.txt'),
      `-DCMAKE_OBJECT_PATH_MAX=${objectPathMax}\n-DPROJECT_ROOT_DIR=${checkout}\\android\n`
    );
    return checkout;
  }

  it('passes for a compliant checkout even when a sibling tree is stale', () => {
    const compliant = makeCheckout('alpha', CMAKE_OBJECT_PATH_MAX);
    makeCheckout('beta', 250);

    expect(verify(compliant)).toBe(0);
  });

  it('still fails for the checkout that is actually stale', () => {
    makeCheckout('alpha', CMAKE_OBJECT_PATH_MAX);
    const stale = makeCheckout('beta', 250);

    expect(verify(stale)).toBe(1);
  });

  it('fails rather than passing vacuously when this checkout has no tree', () => {
    // The non-vacuity guard. Reporting OK here would read as proof the flag
    // arrived when nothing was examined at all.
    makeCheckout('alpha', CMAKE_OBJECT_PATH_MAX);
    const neverBuilt = join(temporaryRoot, 'gamma');
    mkdirSync(neverBuilt, { recursive: true });

    expect(verify(neverBuilt)).toBe(1);
  });
});
