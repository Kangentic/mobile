// '@expo/config-plugins', not 'expo/config-plugins'. The latter subpath does not
// exist in SDK 57; see the comment in withAndroidPushService.ts for what that
// cost.
import { withDangerousMod, withEntitlementsPlist, withXcodeProject, type ConfigPlugin } from '@expo/config-plugins';
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Injects the iOS Notification Service Extension at prebuild time.
 *
 * Push payloads are ciphertext plus a generic placeholder
 * (.claude/rules/e2e-notification-privacy.md), so an iPhone can only show the
 * real task name if something decrypts the envelope before iOS renders the
 * alert. That something is this extension. Android has the Notifee background
 * handler; iOS has nothing until this target exists.
 *
 * CNG: the extension's source lives in `targets/nse/` and is copied into the
 * generated project here, never committed under `ios/`
 * (.claude/rules/expo-cng.md).
 *
 * WHAT THIS PLUGIN DELIBERATELY DOES NOT DO, because `xcode`'s `addTarget`
 * already does it for an `app_extension` (verified by reading
 * node_modules/xcode/lib/pbxProject.js, not assumed):
 *
 *   - it creates the "Copy Files" phase on the first target and adds the
 *     .appex product to it, so adding an Embed App Extensions phase here would
 *     produce a duplicate,
 *   - and it calls addTargetDependency(firstTarget, [newTarget]).
 *
 * What it DOES have to work around is a real bug in the same function: it reads
 * `hash.project.objects.PBXTargetDependency` and `PBXContainerItemProxy`
 * without creating either section first, and then guards the whole write on
 * `if (pbxContainerItemProxySection && pbxTargetDependencySection)`
 * (node_modules/xcode/lib/pbxProject.js). On a project that has never carried a
 * dependency both are undefined, so the call does NOT throw - it silently
 * writes nothing, including the `nativeTargets[target].dependencies.push(...)`
 * that records the app's dependency on the extension. Expect a missing
 * dependency, never an exception. Both sections are pre-created below.
 *
 * `tsc` cannot check any of this: the `xcode` package ships no type
 * declarations, so `XcodeProject` degrades to `any`. The narrow interfaces
 * below restore a check on the calls this file makes, and
 * tests/unit/iosNotificationServiceExtension.test.ts pins the argument shapes,
 * because `expo prebuild --platform ios` cannot run on Windows.
 */

/** The Xcode target name, and the folder the source is copied into under ios/. */
export const NSE_TARGET_NAME = 'KangenticNSE';

export const NSE_INFO_PLIST_FILE_NAME = 'Info.plist';
export const NSE_ENTITLEMENTS_FILE_NAME = 'Kangentic-NSE.entitlements';

/** Appended to the app's bundle identifier. Must match the App ID in the Apple portal. */
export const NSE_BUNDLE_IDENTIFIER_SUFFIX = '.nse';

/**
 * Appended to the app's bundle identifier to form the shared Keychain group.
 * Kept in step with targets/nse/Kangentic-NSE.entitlements and with
 * EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP, which build-ios.yml composes from
 * the profile-derived team id.
 */
export const SHARED_KEYCHAIN_GROUP_SUFFIX = '.shared';

export function nseBundleIdentifier(appBundleIdentifier: string): string {
  return `${appBundleIdentifier}${NSE_BUNDLE_IDENTIFIER_SUFFIX}`;
}

/**
 * The app's `keychain-access-groups`, in an order that is load bearing.
 *
 * ONCE THIS ENTITLEMENT EXISTS, AN UNQUALIFIED `SecItemAdd` LANDS IN THE FIRST
 * ENTRY rather than in the implicit application-identifier group. The
 * app-identifier group is therefore first on purpose: it is the same string the
 * default would have been, which is the only reason `device.identity.sk`, the
 * trust anchor, and the settings store keep their existing home and need no
 * migration. Reordering this array silently relocates every one of those
 * secrets, and the symptom is an app that looks unpaired on next launch.
 */
export function appKeychainAccessGroups(appBundleIdentifier: string, existingGroups: string[] = []): string[] {
  const applicationIdentifierGroup = `$(AppIdentifierPrefix)${appBundleIdentifier}`;
  const sharedGroup = `$(AppIdentifierPrefix)${appBundleIdentifier}${SHARED_KEYCHAIN_GROUP_SUFFIX}`;
  const others = existingGroups.filter(
    (group) => group !== applicationIdentifierGroup && group !== sharedGroup,
  );
  return [applicationIdentifierGroup, sharedGroup, ...others];
}

export interface NseBuildSettingsInputs {
  bundleIdentifier: string;
  marketingVersion: string;
  currentProjectVersion: string;
  deploymentTarget: string;
}

/**
 * Values are quoted because pbxproj treats a bare token and a quoted string
 * differently (the same reason withIosManualSigning quotes its four).
 *
 * MARKETING_VERSION and CURRENT_PROJECT_VERSION are set explicitly rather than
 * inherited: targets/nse/Info.plist reads them through $(...), and App Store
 * Connect rejects an upload whose extension version disagrees with its host
 * app. That rejection lands at upload time, long after CI has gone green.
 */
export function nseBuildSettings(inputs: NseBuildSettingsInputs): Record<string, string> {
  return {
    PRODUCT_NAME: `"${NSE_TARGET_NAME}"`,
    PRODUCT_BUNDLE_IDENTIFIER: `"${inputs.bundleIdentifier}"`,
    INFOPLIST_FILE: `"${NSE_TARGET_NAME}/${NSE_INFO_PLIST_FILE_NAME}"`,
    CODE_SIGN_ENTITLEMENTS: `"${NSE_TARGET_NAME}/${NSE_ENTITLEMENTS_FILE_NAME}"`,
    MARKETING_VERSION: `"${inputs.marketingVersion}"`,
    CURRENT_PROJECT_VERSION: `"${inputs.currentProjectVersion}"`,
    IPHONEOS_DEPLOYMENT_TARGET: `"${inputs.deploymentTarget}"`,
    SWIFT_VERSION: '"5.0"',
    TARGETED_DEVICE_FAMILY: '"1"',
    CLANG_ENABLE_MODULES: '"YES"',
  };
}

interface XcodeBuildConfiguration {
  buildSettings?: Record<string, string | undefined>;
}

/** The subset of `xcode`'s pbxProject this plugin uses. */
export interface XcodeProjectLike {
  pbxTargetByName(name: string): unknown;
  hash: { project: { objects: Record<string, Record<string, unknown>> } };
  getFirstProject(): { firstProject: { mainGroup: string } };
  addPbxGroup(files: string[], name: string, path: string): { uuid: string };
  addToPbxGroup(groupUuid: string, parentGroupUuid: string): void;
  addTarget(name: string, type: string, subfolder: string, bundleId: string): { uuid: string };
  addBuildPhase(files: string[], phaseType: string, comment: string, targetUuid: string): unknown;
  pbxXCBuildConfigurationSection(): Record<string, XcodeBuildConfiguration | string>;
}

export interface AddNseTargetOptions {
  sourceFileNames: string[];
  resourceFileNames: string[];
  buildSettings: Record<string, string>;
  bundleIdentifier: string;
}

/**
 * Reads the app target's deployment target so the extension matches it rather
 * than pinning a version that drifts from the app's.
 */
export function readAppDeploymentTarget(project: XcodeProjectLike, appTargetName: string): string | null {
  const configurations = project.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configurations)) {
    const configuration = configurations[key];
    if (typeof configuration !== 'object' || configuration === null) continue;
    const buildSettings = configuration.buildSettings;
    if (!buildSettings) continue;
    if (buildSettings.PRODUCT_NAME !== `"${appTargetName}"`) continue;
    const deploymentTarget = buildSettings.IPHONEOS_DEPLOYMENT_TARGET;
    if (typeof deploymentTarget === 'string' && deploymentTarget.length > 0) {
      return deploymentTarget.replace(/"/g, '');
    }
  }
  return null;
}

/**
 * Creates the extension target and writes its build settings. Returns false
 * when the target already exists, which makes a repeat prebuild a no-op rather
 * than adding a second target.
 *
 * KNOWN ASYMMETRY, harmless in CI and confusing locally: withNseSourceFiles
 * copies targets/nse/ on EVERY prebuild, while this early-return skips the
 * build-settings write and the Sources phase. On a clean prebuild (what CI and
 * every real build do) the two agree. On a repeat local `expo prebuild` without
 * `--clean`, a bumped version/buildNumber never reaches MARKETING_VERSION and a
 * newly added Swift file lands on disk without joining the Sources phase, until
 * the next clean prebuild. Nothing ships wrong: verify-ios-signature.sh fails
 * the archive on a version pair that disagrees with the app's. Run
 * `expo prebuild --clean` after changing either.
 */
export function addNotificationServiceExtensionTarget(
  project: XcodeProjectLike,
  options: AddNseTargetOptions,
): boolean {
  if (project.pbxTargetByName(NSE_TARGET_NAME)) return false;

  const group = project.addPbxGroup(
    [...options.sourceFileNames, ...options.resourceFileNames],
    NSE_TARGET_NAME,
    NSE_TARGET_NAME,
  );
  project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);

  // See the header: addTarget's dependency write is guarded on both sections
  // already existing, so without this the app target silently ends up with no
  // dependency on the extension. It fails quietly, not with an exception.
  const projectObjects = project.hash.project.objects;
  projectObjects.PBXTargetDependency = projectObjects.PBXTargetDependency ?? {};
  projectObjects.PBXContainerItemProxy = projectObjects.PBXContainerItemProxy ?? {};

  const target = project.addTarget(NSE_TARGET_NAME, 'app_extension', NSE_TARGET_NAME, options.bundleIdentifier);
  project.addBuildPhase(options.sourceFileNames, 'PBXSourcesBuildPhase', 'Sources', target.uuid);
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);

  const configurations = project.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configurations)) {
    const configuration = configurations[key];
    if (typeof configuration !== 'object' || configuration === null) continue;
    const buildSettings = configuration.buildSettings;
    if (!buildSettings) continue;
    // addTarget stamps PRODUCT_NAME on exactly this target's Debug and Release
    // configurations, which is what makes them findable here.
    if (buildSettings.PRODUCT_NAME !== `"${NSE_TARGET_NAME}"`) continue;
    for (const [setting, value] of Object.entries(options.buildSettings)) {
      buildSettings[setting] = value;
    }
  }

  return true;
}

/** Every file directly inside targets/nse/, ignoring any nested directory. */
export function listExtensionSourceFiles(sourceDirectory: string): string[] {
  return readdirSync(sourceDirectory).filter((entry) => statSync(join(sourceDirectory, entry)).isFile());
}

const withNseSourceFiles: ConfigPlugin = (config) =>
  withDangerousMod(config, [
    'ios',
    (dangerousConfig) => {
      const sourceDirectory = join(dangerousConfig.modRequest.projectRoot, 'targets', 'nse');
      const destinationDirectory = join(dangerousConfig.modRequest.platformProjectRoot, NSE_TARGET_NAME);
      mkdirSync(destinationDirectory, { recursive: true });
      for (const fileName of listExtensionSourceFiles(sourceDirectory)) {
        copyFileSync(join(sourceDirectory, fileName), join(destinationDirectory, fileName));
      }
      return dangerousConfig;
    },
  ]);

const withAppKeychainSharing: ConfigPlugin = (config) =>
  withEntitlementsPlist(config, (entitlementsConfig) => {
    const bundleIdentifier = entitlementsConfig.ios?.bundleIdentifier;
    if (!bundleIdentifier) {
      throw new Error('withIosNotificationServiceExtension needs ios.bundleIdentifier to build the Keychain group.');
    }
    const existing = entitlementsConfig.modResults['keychain-access-groups'];
    const existingGroups = Array.isArray(existing) ? existing.filter((group): group is string => typeof group === 'string') : [];
    entitlementsConfig.modResults['keychain-access-groups'] = appKeychainAccessGroups(bundleIdentifier, existingGroups);
    return entitlementsConfig;
  });

const withNseTarget: ConfigPlugin = (config) =>
  withXcodeProject(config, (xcodeConfig) => {
    const appTargetName = xcodeConfig.modRequest.projectName;
    if (!appTargetName) {
      throw new Error('withIosNotificationServiceExtension could not resolve the app target name from the prebuild request.');
    }
    const bundleIdentifier = xcodeConfig.ios?.bundleIdentifier;
    if (!bundleIdentifier) {
      throw new Error('withIosNotificationServiceExtension needs ios.bundleIdentifier to name the extension target.');
    }

    const project: XcodeProjectLike = xcodeConfig.modResults;
    const sourceDirectory = join(xcodeConfig.modRequest.projectRoot, 'targets', 'nse');
    const allFiles = listExtensionSourceFiles(sourceDirectory);
    const sourceFileNames = allFiles.filter((fileName) => fileName.endsWith('.swift'));
    const resourceFileNames = allFiles.filter((fileName) => !fileName.endsWith('.swift'));

    if (sourceFileNames.length === 0) {
      throw new Error(`withIosNotificationServiceExtension found no Swift source in ${sourceDirectory}.`);
    }

    addNotificationServiceExtensionTarget(project, {
      sourceFileNames,
      resourceFileNames,
      bundleIdentifier: nseBundleIdentifier(bundleIdentifier),
      buildSettings: nseBuildSettings({
        bundleIdentifier: nseBundleIdentifier(bundleIdentifier),
        marketingVersion: xcodeConfig.version ?? '1.0.0',
        currentProjectVersion: xcodeConfig.ios?.buildNumber ?? '1',
        // Mirrors the app rather than pinning: a version below the app's fails
        // to link, and one above silently raises the app's minimum iOS.
        deploymentTarget: readAppDeploymentTarget(project, appTargetName) ?? '15.1',
      }),
    });

    return xcodeConfig;
  });

const withIosNotificationServiceExtension: ConfigPlugin = (config) => {
  // Source files first: the pbxproj references them by name, and a project that
  // points at files prebuild never wrote fails at compile time rather than here.
  return withNseTarget(withAppKeychainSharing(withNseSourceFiles(config)));
};

export default withIosNotificationServiceExtension;
