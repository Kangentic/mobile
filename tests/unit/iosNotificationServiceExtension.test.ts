/**
 * Covers plugins/withIosNotificationServiceExtension.ts, which injects the iOS
 * Notification Service Extension target at prebuild time.
 *
 * This needs a test more than most plugins do, for the same reason
 * iosManualSigning.test.ts does and then some: the `xcode` package ships no
 * type declarations, so every pbxproj call degrades to `any` and `tsc` checks
 * nothing about it, and `expo prebuild --platform ios` cannot run on Windows.
 * Unlike the signing plugin, this one CREATES a target, so a wrong call order
 * or a duplicated build phase produces a project that still parses and fails
 * somewhere deep in xcodebuild.
 *
 * The most valuable assertion here is the keychain-access-group ORDER. Once
 * that entitlement exists, an unqualified SecItemAdd lands in the first entry
 * rather than the implicit application-identifier group, so reordering the
 * array silently relocates the device identity key, the trust anchor, and the
 * settings store, and the app reads as unpaired on next launch.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  NSE_TARGET_NAME,
  addNotificationServiceExtensionTarget,
  appKeychainAccessGroups,
  nseBuildSettings,
  nseBundleIdentifier,
  readAppDeploymentTarget,
  type XcodeProjectLike,
} from '../../plugins/withIosNotificationServiceExtension';

const APP_BUNDLE_IDENTIFIER = 'com.kangentic.mobile';
const APP_TARGET_NAME = 'Kangentic';

const entitlementsPath = join(__dirname, '..', '..', 'targets', 'nse', 'Kangentic-NSE.entitlements');

interface RecordedBuildPhase {
  files: string[];
  phaseType: string;
  comment: string;
  targetUuid: string;
}

interface RecordedTarget {
  name: string;
  type: string;
  subfolder: string;
  bundleId: string;
}

interface RecordingProject {
  project: XcodeProjectLike;
  buildPhases: RecordedBuildPhase[];
  targets: RecordedTarget[];
  groups: { files: string[]; name: string; path: string }[];
  groupParents: { groupUuid: string; parentGroupUuid: string }[];
  configurations: Record<string, { buildSettings?: Record<string, string | undefined> }>;
}

/**
 * A stand-in for `xcode`'s pbxProject, seeded with the two build
 * configurations prebuild produces for the app target. `addTarget` mirrors the
 * real one by stamping a quoted PRODUCT_NAME onto the new target's Debug and
 * Release configurations, because that is what the plugin uses to find them.
 */
function createRecordingProject(options: { existingTargetNames?: string[] } = {}): RecordingProject {
  const buildPhases: RecordedBuildPhase[] = [];
  const targets: RecordedTarget[] = [];
  const groups: { files: string[]; name: string; path: string }[] = [];
  const groupParents: { groupUuid: string; parentGroupUuid: string }[] = [];
  const existingTargetNames = options.existingTargetNames ?? [];

  const configurations: Record<string, { buildSettings?: Record<string, string | undefined> }> = {
    'APP-DEBUG': {
      buildSettings: { PRODUCT_NAME: `"${APP_TARGET_NAME}"`, IPHONEOS_DEPLOYMENT_TARGET: '16.4' },
    },
    'APP-RELEASE': {
      buildSettings: { PRODUCT_NAME: `"${APP_TARGET_NAME}"`, IPHONEOS_DEPLOYMENT_TARGET: '16.4' },
    },
    // The real section carries non-object entries (comment keys) alongside the
    // configurations; the plugin has to skip them rather than crash.
    'APP-DEBUG_comment': 'Debug' as unknown as { buildSettings?: Record<string, string | undefined> },
  };

  const project: XcodeProjectLike = {
    pbxTargetByName(name: string) {
      return existingTargetNames.includes(name) ? { uuid: 'EXISTING' } : undefined;
    },
    hash: { project: { objects: {} } },
    getFirstProject() {
      return { firstProject: { mainGroup: 'MAIN-GROUP' } };
    },
    addPbxGroup(files: string[], name: string, path: string) {
      groups.push({ files, name, path });
      return { uuid: 'NSE-GROUP' };
    },
    addToPbxGroup(groupUuid: string, parentGroupUuid: string) {
      groupParents.push({ groupUuid, parentGroupUuid });
    },
    addTarget(name: string, type: string, subfolder: string, bundleId: string) {
      targets.push({ name, type, subfolder, bundleId });
      configurations['NSE-DEBUG'] = { buildSettings: { PRODUCT_NAME: `"${name}"` } };
      configurations['NSE-RELEASE'] = { buildSettings: { PRODUCT_NAME: `"${name}"` } };
      return { uuid: 'NSE-TARGET' };
    },
    addBuildPhase(files: string[], phaseType: string, comment: string, targetUuid: string) {
      buildPhases.push({ files, phaseType, comment, targetUuid });
      return {};
    },
    pbxXCBuildConfigurationSection() {
      return configurations;
    },
  };

  return { project, buildPhases, targets, groups, groupParents, configurations };
}

const SOURCE_FILES = [
  'CategoryCopy.swift',
  'HChaCha20.swift',
  'NotificationService.swift',
  'PushEnvelope.swift',
  'SharedKeychain.swift',
];
const RESOURCE_FILES = ['Info.plist', 'Kangentic-NSE.entitlements'];

function addTarget(recording: RecordingProject): boolean {
  return addNotificationServiceExtensionTarget(recording.project, {
    sourceFileNames: SOURCE_FILES,
    resourceFileNames: RESOURCE_FILES,
    bundleIdentifier: nseBundleIdentifier(APP_BUNDLE_IDENTIFIER),
    buildSettings: nseBuildSettings({
      bundleIdentifier: nseBundleIdentifier(APP_BUNDLE_IDENTIFIER),
      marketingVersion: '0.6.0',
      currentProjectVersion: '10',
      deploymentTarget: '16.4',
    }),
  });
}

describe('appKeychainAccessGroups', () => {
  it('puts the application-identifier group FIRST, then the shared group', () => {
    // Load bearing, not cosmetic. The first entry becomes the default group for
    // every unqualified write, and deviceIdentity.ts, trustAnchor.ts and
    // settingsStore.ts all write unqualified. Reversing this moves all three.
    expect(appKeychainAccessGroups(APP_BUNDLE_IDENTIFIER)).toEqual([
      '$(AppIdentifierPrefix)com.kangentic.mobile',
      '$(AppIdentifierPrefix)com.kangentic.mobile.shared',
    ]);
  });

  it('uses the AppIdentifierPrefix variable, never a literal team id', () => {
    // The repo is public and the whole signing pipeline derives the team id
    // from the provisioning profile on the runner (no-personal-info.md).
    for (const group of appKeychainAccessGroups(APP_BUNDLE_IDENTIFIER)) {
      expect(group.startsWith('$(AppIdentifierPrefix)')).toBe(true);
      expect(group).not.toMatch(/^[A-Z0-9]{10}\./);
    }
  });

  it('is idempotent across repeated prebuilds', () => {
    const once = appKeychainAccessGroups(APP_BUNDLE_IDENTIFIER);
    expect(appKeychainAccessGroups(APP_BUNDLE_IDENTIFIER, once)).toEqual(once);
  });

  it('keeps unrelated groups a future plugin may have added, after ours', () => {
    expect(appKeychainAccessGroups(APP_BUNDLE_IDENTIFIER, ['$(AppIdentifierPrefix)com.other.group'])).toEqual([
      '$(AppIdentifierPrefix)com.kangentic.mobile',
      '$(AppIdentifierPrefix)com.kangentic.mobile.shared',
      '$(AppIdentifierPrefix)com.other.group',
    ]);
  });
});

describe('the checked-in entitlements file matches appKeychainAccessGroups', () => {
  // targets/nse/Kangentic-NSE.entitlements hardcodes the shared group as a
  // literal string, because it is a plist copied verbatim into the generated
  // project rather than written by this plugin. appKeychainAccessGroups derives
  // the same string from the app's bundle identifier. Nothing compares the two
  // outside this test, so a bundle-identifier rename would desync them silently:
  // the extension would still build and sign, and the only symptom would be
  // every push degrading to the placeholder, indistinguishable from an NSE that
  // never ran at all.
  it('carries exactly the shared group appKeychainAccessGroups derives for the real app bundle id, and only that group', () => {
    const entitlementsXml = readFileSync(entitlementsPath, 'utf8');

    const keychainGroupsSection = entitlementsXml.match(
      /<key>keychain-access-groups<\/key>\s*<array>([\s\S]*?)<\/array>/,
    );
    expect(keychainGroupsSection).not.toBeNull();

    const groupEntries = Array.from(
      (keychainGroupsSection?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g),
      (match) => match[1],
    );

    // ONE GROUP, deliberately: the file's own header says the extension must
    // never carry the app-identifier group, so it cannot reach the identity
    // secret key, the trust anchor, or the settings store. That containment
    // argument depends on this list never growing a second entry.
    expect(groupEntries).toHaveLength(1);

    // The derived value, not a restated literal: if this hardcoded the expected
    // string too, a rename that moved both literals together would still pass.
    expect(groupEntries[0]).toBe(appKeychainAccessGroups(APP_BUNDLE_IDENTIFIER)[1]);
  });
});

describe('nseBundleIdentifier', () => {
  it('appends .nse, matching the App ID that has to exist in the Apple portal', () => {
    expect(nseBundleIdentifier(APP_BUNDLE_IDENTIFIER)).toBe('com.kangentic.mobile.nse');
  });
});

describe('nseBuildSettings', () => {
  it('quotes every value, because pbxproj distinguishes a bare token', () => {
    const settings = nseBuildSettings({
      bundleIdentifier: 'com.kangentic.mobile.nse',
      marketingVersion: '0.6.0',
      currentProjectVersion: '10',
      deploymentTarget: '16.4',
    });
    for (const value of Object.values(settings)) {
      expect(value.startsWith('"')).toBe(true);
      expect(value.endsWith('"')).toBe(true);
    }
  });

  it('pins the version pair the App Store validates against the host app', () => {
    // An extension whose CFBundleShortVersionString or CFBundleVersion differs
    // from the app is rejected at upload, long after CI has gone green.
    const settings = nseBuildSettings({
      bundleIdentifier: 'com.kangentic.mobile.nse',
      marketingVersion: '0.6.0',
      currentProjectVersion: '10',
      deploymentTarget: '16.4',
    });
    expect(settings.MARKETING_VERSION).toBe('"0.6.0"');
    expect(settings.CURRENT_PROJECT_VERSION).toBe('"10"');
  });

  it('points Info.plist and the entitlements at the copied target folder', () => {
    const settings = nseBuildSettings({
      bundleIdentifier: 'com.kangentic.mobile.nse',
      marketingVersion: '0.6.0',
      currentProjectVersion: '10',
      deploymentTarget: '16.4',
    });
    expect(settings.INFOPLIST_FILE).toBe(`"${NSE_TARGET_NAME}/Info.plist"`);
    expect(settings.CODE_SIGN_ENTITLEMENTS).toBe(`"${NSE_TARGET_NAME}/Kangentic-NSE.entitlements"`);
  });
});

describe('readAppDeploymentTarget', () => {
  it('mirrors the app target rather than pinning a version that can drift', () => {
    const recording = createRecordingProject();
    expect(readAppDeploymentTarget(recording.project, APP_TARGET_NAME)).toBe('16.4');
  });

  it('returns null when the app target carries none, so the caller can fall back', () => {
    const recording = createRecordingProject();
    delete recording.configurations['APP-DEBUG'].buildSettings?.IPHONEOS_DEPLOYMENT_TARGET;
    delete recording.configurations['APP-RELEASE'].buildSettings?.IPHONEOS_DEPLOYMENT_TARGET;
    expect(readAppDeploymentTarget(recording.project, APP_TARGET_NAME)).toBeNull();
  });
});

describe('addNotificationServiceExtensionTarget', () => {
  it('creates one app_extension target with the .nse bundle id', () => {
    const recording = createRecordingProject();
    expect(addTarget(recording)).toBe(true);
    expect(recording.targets).toEqual([
      {
        name: NSE_TARGET_NAME,
        // 'app_extension' is what makes xcode's addTarget create the Copy Files
        // phase on the app target and add the target dependency. Any other type
        // silently produces an unembedded extension.
        type: 'app_extension',
        subfolder: NSE_TARGET_NAME,
        bundleId: 'com.kangentic.mobile.nse',
      },
    ]);
  });

  it('pre-creates the two sections xcode addTarget assigns into without creating', () => {
    // Without this, addTarget throws on a project that has never carried a
    // target dependency. Verified against node_modules/xcode/lib/pbxProject.js.
    const recording = createRecordingProject();
    addTarget(recording);
    expect(recording.project.hash.project.objects.PBXTargetDependency).toBeDefined();
    expect(recording.project.hash.project.objects.PBXContainerItemProxy).toBeDefined();
  });

  it('adds exactly three build phases, and never an Embed App Extensions phase', () => {
    // xcode's addTarget already creates the Copy Files phase on the first
    // target and adds the .appex to it. Adding one here would duplicate it.
    const recording = createRecordingProject();
    addTarget(recording);

    expect(recording.buildPhases.map((phase) => phase.phaseType)).toEqual([
      'PBXSourcesBuildPhase',
      'PBXResourcesBuildPhase',
      'PBXFrameworksBuildPhase',
    ]);
    expect(recording.buildPhases.some((phase) => phase.phaseType === 'PBXCopyFilesBuildPhase')).toBe(false);
    for (const phase of recording.buildPhases) {
      expect(phase.targetUuid).toBe('NSE-TARGET');
    }
  });

  it('compiles every Swift file and no resource file', () => {
    const recording = createRecordingProject();
    addTarget(recording);

    const sourcesPhase = recording.buildPhases.find((phase) => phase.phaseType === 'PBXSourcesBuildPhase');
    expect(sourcesPhase?.files).toEqual(SOURCE_FILES);
    // A .plist or .entitlements in the Sources phase fails the build.
    for (const fileName of sourcesPhase?.files ?? []) {
      expect(fileName.endsWith('.swift')).toBe(true);
    }
  });

  it('puts every file in the target group and hangs it off the main group', () => {
    const recording = createRecordingProject();
    addTarget(recording);

    expect(recording.groups).toEqual([
      { files: [...SOURCE_FILES, ...RESOURCE_FILES], name: NSE_TARGET_NAME, path: NSE_TARGET_NAME },
    ]);
    expect(recording.groupParents).toEqual([{ groupUuid: 'NSE-GROUP', parentGroupUuid: 'MAIN-GROUP' }]);
  });

  it('writes the build settings onto the extension configurations only', () => {
    const recording = createRecordingProject();
    addTarget(recording);

    for (const key of ['NSE-DEBUG', 'NSE-RELEASE']) {
      const buildSettings = recording.configurations[key].buildSettings;
      expect(buildSettings?.PRODUCT_BUNDLE_IDENTIFIER).toBe('"com.kangentic.mobile.nse"');
      expect(buildSettings?.INFOPLIST_FILE).toBe(`"${NSE_TARGET_NAME}/Info.plist"`);
      expect(buildSettings?.CODE_SIGN_ENTITLEMENTS).toBe(`"${NSE_TARGET_NAME}/Kangentic-NSE.entitlements"`);
      expect(buildSettings?.SWIFT_VERSION).toBe('"5.0"');
    }
    // The app target must be left exactly as the signing plugin left it.
    for (const key of ['APP-DEBUG', 'APP-RELEASE']) {
      expect(recording.configurations[key].buildSettings?.CODE_SIGN_ENTITLEMENTS).toBeUndefined();
      expect(recording.configurations[key].buildSettings?.PRODUCT_BUNDLE_IDENTIFIER).toBeUndefined();
    }
  });

  it('is a no-op when the target already exists, so a repeat prebuild adds nothing', () => {
    // The bug androidCmakeBuildStaging.test.ts guards against on the Android
    // side: prebuild runs more than once, and a second target here would be a
    // duplicate-bundle-id rejection at upload.
    const recording = createRecordingProject({ existingTargetNames: [NSE_TARGET_NAME] });

    expect(addTarget(recording)).toBe(false);
    expect(recording.targets).toEqual([]);
    expect(recording.buildPhases).toEqual([]);
    expect(recording.groups).toEqual([]);
  });
});
