// '@expo/config-plugins', not 'expo/config-plugins'. The latter subpath does not
// exist in SDK 57; see the comment in withAndroidPushService.ts for what that
// cost.
import { withXcodeProject, type ConfigPlugin } from '@expo/config-plugins';

/**
 * Duplicated from withIosNotificationServiceExtension.ts rather than imported,
 * and that is not laziness.
 *
 * Expo's plugin loader transpiles each plugin file on its own and `require`s
 * the result, so a relative import of a sibling `.ts` resolves to a `.js` that
 * was never emitted. `import { NSE_TARGET_NAME } from
 * './withIosNotificationServiceExtension'` was tried and failed prebuild with
 * "Cannot find module" - on ANDROID as well as iOS, because the plugin file is
 * loaded whatever the platform. An iOS-only feature took the Android build down
 * with it. Same family as the `expo/config-plugins` import documented in
 * withAndroidPushService.ts.
 *
 * tests/unit/iosManualSigning.test.ts asserts this equals the exported constant
 * so the two cannot drift.
 */
export const NSE_TARGET_NAME = 'KangenticNSE';

/**
 * Applies manual App Store signing to the **app target only**.
 *
 * Why a config plugin rather than `xcodebuild` command-line settings: settings
 * passed on the command line apply to every target in the workspace, including
 * CocoaPods and Swift Package ones, and a target that produces no signed bundle
 * rejects a provisioning profile outright. That is not theoretical here. The
 * first signed archive failed with:
 *
 *   RaTeX_RaTeX does not support provisioning profiles, but provisioning
 *   profile <uuid> has been manually specified.
 *
 * The usual workaround is to archive unsigned and sign at export instead. This
 * project deliberately does not: an unsigned archive carries no
 * archived-expanded-entitlements.xcent, so the re-sign at export can silently
 * drop custom entitlements, and losing `aps-environment` ships an app that
 * installs, launches, and never receives a push. Setting the properties on one
 * target keeps the archive signed without touching anything that cannot be.
 *
 * Exempting each offending target by name would be whack-a-mole: the dependency
 * graph decides how many there are, and the next `expo install` can add one.
 *
 * CNG: this is how `ios/` gets native config (.claude/rules/expo-cng.md). The
 * generated project is never hand-edited and never committed.
 *
 * Inert without all three environment variables, so a local `expo prebuild` and
 * the unsigned simulator job are unaffected. `.github/workflows/build-ios.yml`
 * sets them from the installed provisioning profile, which means nothing about
 * the Apple team is committed (.claude/rules/no-personal-info.md).
 */
export interface ManualSigningInputs {
  teamId: string;
  profileUuid: string;
  /** The certificate's SHA-1, not its name: see install-ios-signing.sh. */
  signingIdentity: string;
}

export function readSigningInputsFromEnvironment(
  // Deliberately not NodeJS.ProcessEnv: Expo's types augment it with a required
  // NODE_ENV, so a test could not pass a small literal.
  environment: Readonly<Record<string, string | undefined>> = process.env
): ManualSigningInputs | null {
  const teamId = environment.KANGENTIC_IOS_TEAM_ID;
  const profileUuid = environment.KANGENTIC_IOS_PROFILE_UUID;
  const signingIdentity = environment.KANGENTIC_IOS_SIGNING_IDENTITY;

  if (!teamId || !profileUuid || !signingIdentity) {
    return null;
  }
  return { teamId, profileUuid, signingIdentity };
}

/**
 * The Notification Service Extension's own provisioning profile.
 *
 * An app extension is a separate bundle id, so it cannot share the app's
 * profile. Read separately from the three above so a missing value degrades to
 * "do not touch that target" rather than turning off signing everywhere: the
 * archive then fails on the extension with Xcode's own message instead of
 * producing a differently-broken build.
 */
export function readNseProfileUuidFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env
): string | null {
  const nseProfileUuid = environment.KANGENTIC_IOS_NSE_PROFILE_UUID;
  return nseProfileUuid ? nseProfileUuid : null;
}

/**
 * The one method of `xcode`'s pbxProject this plugin needs.
 *
 * Declared locally because the `xcode` package ships no type declarations at
 * all, so `XcodeProject` degrades to `any` and `tsc` silently checks nothing
 * about the call below. Naming the shape here restores that check and lets
 * tests/unit/iosManualSigning.test.ts assert the exact arguments.
 *
 * Signature per xcode@3.0.1 `pbxProject.prototype.updateBuildProperty`: with a
 * targetName it confines the write to that target's build configurations, and
 * with no build name it applies to every configuration of that target.
 */
export interface XcodeBuildSettingsWriter {
  updateBuildProperty(property: string, value: string, build?: string, targetName?: string): void;
}

/** The lookup half of `xcode`'s pbxProject, needed by resolveStoredTargetName below. */
export interface XcodeTargetLookup {
  pbxTargetByName(name: string): unknown;
}

/**
 * The target name AS THE PBXPROJ STORES IT, which is not always the name you
 * asked for. Returns null when no target matches either spelling.
 *
 * This exists because of a real defect that shipped a broken v0.6.3 iOS build.
 * `xcode`'s `addTarget` stores a target's name QUOTED - `name: '"' + targetName
 * + '"'` (pbxProject.js:1489) - and `addToPbxNativeTargetSection` writes that
 * value verbatim as the section comment (:574). But `pbxTargetByName` resolves
 * through `pbxItemByComment`, which compares the comment to the raw string
 * (:1031). So for any target created by `addTarget`, looking it up by its own
 * name compares `"KangenticNSE"` against `KangenticNSE` and returns null.
 *
 * `updateBuildProperty` then finds no build configurations for that target and
 * writes NOTHING, with no error (:1132-1155). That is how the Notification
 * Service Extension reached an archive carrying the APP's provisioning profile
 * and none of its own: the plugin ran, the call succeeded, and nothing changed.
 *
 * The app target is unaffected because `expo prebuild` creates it, not
 * `addTarget`, and stores its name unquoted - which is exactly why the app half
 * of this plugin has always worked and hid the extension half being dead.
 *
 * Both spellings are tried rather than just the quoted one: the unquoted lookup
 * has to stay first so a prebuild-created target keeps resolving as it does
 * today, and the quoted fallback covers anything `addTarget` made.
 */
export function resolveStoredTargetName(project: XcodeTargetLookup, targetName: string): string | null {
  if (project.pbxTargetByName(targetName)) return targetName;
  if (project.pbxTargetByName(`"${targetName}"`)) return `"${targetName}"`;
  return null;
}

/**
 * Writes manual signing onto one target. Values are quoted because pbxproj
 * treats a bare token and a quoted string differently.
 */
export function applyManualSigningToTarget(
  project: XcodeBuildSettingsWriter,
  targetName: string,
  inputs: ManualSigningInputs
): void {
  const buildSettings: Record<string, string> = {
    CODE_SIGN_STYLE: 'Manual',
    DEVELOPMENT_TEAM: inputs.teamId,
    PROVISIONING_PROFILE_SPECIFIER: inputs.profileUuid,
    CODE_SIGN_IDENTITY: inputs.signingIdentity,
  };

  for (const [property, value] of Object.entries(buildSettings)) {
    project.updateBuildProperty(property, `"${value}"`, undefined, targetName);
  }
}

const withIosManualSigning: ConfigPlugin = (config) => {
  return withXcodeProject(config, (xcodeConfig) => {
    const inputs = readSigningInputsFromEnvironment();
    if (!inputs) {
      return xcodeConfig;
    }

    // The app target is named after the Xcode project, which expo prebuild names
    // after the app. Resolved rather than hardcoded so a rename cannot silently
    // turn this plugin into a no-op.
    const targetName = xcodeConfig.modRequest.projectName;
    if (!targetName) {
      throw new Error(
        'withIosManualSigning could not resolve the app target name from the prebuild request.'
      );
    }

    const project: XcodeBuildSettingsWriter & XcodeTargetLookup = xcodeConfig.modResults;
    const storedAppTargetName = resolveStoredTargetName(project, targetName);
    if (!storedAppTargetName) {
      throw new Error(
        `withIosManualSigning found no Xcode target named ${targetName}, so it would have signed nothing.`
      );
    }
    applyManualSigningToTarget(project, storedAppTargetName, inputs);

    // The extension target, when one has been created. It carries its own
    // bundle id and therefore its own profile; everything else (team,
    // certificate, manual style) is shared with the app.
    //
    // This runs after withIosNotificationServiceExtension by registration order
    // in app.config.ts. Reversed, there is no target to find and the throw
    // below fires.
    //
    // THROWING IS THE POINT. Before resolveStoredTargetName existed this passed
    // the plain name straight to updateBuildProperty, which could not match the
    // quoted name `addTarget` stores, matched no build configurations, and wrote
    // nothing while returning normally. The archive then carried the extension
    // on the app's profile. A silent no-op in a signing plugin is the failure
    // mode worth refusing outright, so an unresolvable target is now an error
    // rather than a quiet skip.
    const nseProfileUuid = readNseProfileUuidFromEnvironment();
    if (nseProfileUuid) {
      const storedNseTargetName = resolveStoredTargetName(project, NSE_TARGET_NAME);
      if (!storedNseTargetName) {
        throw new Error(
          `withIosManualSigning found no Xcode target named ${NSE_TARGET_NAME}. ` +
            'withIosNotificationServiceExtension must create it BEFORE this plugin runs (check the order in app.config.ts).'
        );
      }
      applyManualSigningToTarget(project, storedNseTargetName, { ...inputs, profileUuid: nseProfileUuid });
    }

    return xcodeConfig;
  });
};

export default withIosManualSigning;
