// '@expo/config-plugins', not 'expo/config-plugins'. The latter subpath does not
// exist in SDK 57; see the comment in withAndroidPushService.ts for what that
// cost.
import { withXcodeProject, type ConfigPlugin } from '@expo/config-plugins';

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

    const project: XcodeBuildSettingsWriter = xcodeConfig.modResults;
    applyManualSigningToTarget(project, targetName, inputs);

    return xcodeConfig;
  });
};

export default withIosManualSigning;
