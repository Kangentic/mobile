/**
 * Covers plugins/withIosManualSigning.ts, the plugin that puts App Store signing
 * on the iOS app target instead of on every target in the workspace.
 *
 * This needs a test more than most plugins do. The `xcode` package ships no type
 * declarations at all, so `XcodeProject` degrades to `any` and `tsc` checks
 * nothing about the `updateBuildProperty` call: a wrong argument order or a typo
 * in a build-setting name would compile clean and produce an archive that is
 * silently still on automatic signing. There is also no way to run
 * `expo prebuild --platform ios` on Windows to find out, so the only local signal
 * is this.
 *
 * The argument shape asserted here comes from reading xcode@3.0.1's
 * `pbxProject.prototype.updateBuildProperty`: with a targetName it confines the
 * write to that target's build configurations, and with no build name it applies
 * to every configuration of that target.
 */
import { describe, expect, it } from 'vitest';

import {
  NSE_TARGET_NAME as SIGNING_SIDE_NSE_TARGET_NAME,
  applyManualSigningToTarget,
  readSigningInputsFromEnvironment,
  resolveStoredTargetName,
  type XcodeBuildSettingsWriter,
} from '../../plugins/withIosManualSigning';
import { NSE_TARGET_NAME } from '../../plugins/withIosNotificationServiceExtension';

const INPUTS = {
  teamId: 'AF8KY83RAF',
  profileUuid: 'e168ea1e-139b-45ad-b5f1-6783cd3a6c6b',
  signingIdentity: '34B01547D39D5296A90F151E5C5824420A632D80',
};

interface RecordedWrite {
  property: string;
  value: string;
  build: string | undefined;
  targetName: string | undefined;
}

function createRecordingProject(): { project: XcodeBuildSettingsWriter; writes: RecordedWrite[] } {
  const writes: RecordedWrite[] = [];
  return {
    writes,
    project: {
      updateBuildProperty(property, value, build, targetName) {
        writes.push({ property, value, build, targetName });
      },
    },
  };
}

describe('the extension target name', () => {
  it('matches the plugin that actually creates the target', () => {
    // The two plugins hold this string separately because Expo transpiles each
    // plugin file on its own, so a relative import of a sibling .ts resolves to
    // a .js that was never emitted. That was not theoretical: it failed prebuild
    // with "Cannot find module" on ANDROID as well as iOS, because the plugin
    // file loads whatever the platform. Duplicated deliberately, pinned here.
    expect(SIGNING_SIDE_NSE_TARGET_NAME).toBe(NSE_TARGET_NAME);
  });
});

describe('readSigningInputsFromEnvironment', () => {
  it('reads all three variables', () => {
    expect(
      readSigningInputsFromEnvironment({
        KANGENTIC_IOS_TEAM_ID: INPUTS.teamId,
        KANGENTIC_IOS_PROFILE_UUID: INPUTS.profileUuid,
        KANGENTIC_IOS_SIGNING_IDENTITY: INPUTS.signingIdentity,
      })
    ).toEqual(INPUTS);
  });

  it('is inert unless every variable is present', () => {
    // A partial set must not half-apply signing. It also keeps a local
    // `expo prebuild` and the unsigned simulator job untouched.
    expect(readSigningInputsFromEnvironment({})).toBeNull();
    expect(readSigningInputsFromEnvironment({ KANGENTIC_IOS_TEAM_ID: INPUTS.teamId })).toBeNull();
    expect(
      readSigningInputsFromEnvironment({
        KANGENTIC_IOS_TEAM_ID: INPUTS.teamId,
        KANGENTIC_IOS_PROFILE_UUID: INPUTS.profileUuid,
      })
    ).toBeNull();
  });

  it('treats an empty string as absent', () => {
    // A GitHub Actions step output that resolved to nothing arrives as '', not
    // undefined, so a truthiness check is load bearing here.
    expect(
      readSigningInputsFromEnvironment({
        KANGENTIC_IOS_TEAM_ID: INPUTS.teamId,
        KANGENTIC_IOS_PROFILE_UUID: '',
        KANGENTIC_IOS_SIGNING_IDENTITY: INPUTS.signingIdentity,
      })
    ).toBeNull();
  });
});

describe('applyManualSigningToTarget', () => {
  it('writes exactly the four settings a manual archive needs', () => {
    const { project, writes } = createRecordingProject();
    applyManualSigningToTarget(project, 'Kangentic', INPUTS);

    expect(writes.map((write) => write.property).sort()).toEqual([
      'CODE_SIGN_IDENTITY',
      'CODE_SIGN_STYLE',
      'DEVELOPMENT_TEAM',
      'PROVISIONING_PROFILE_SPECIFIER',
    ]);
  });

  it('scopes every write to the named target', () => {
    // The whole point of the plugin. An unscoped write is what broke the first
    // signed archive, on a Swift Package target that cannot take a profile.
    const { project, writes } = createRecordingProject();
    applyManualSigningToTarget(project, 'Kangentic', INPUTS);

    expect(writes).not.toHaveLength(0);
    for (const write of writes) {
      expect(write.targetName).toBe('Kangentic');
    }
  });

  it('applies to every build configuration of that target', () => {
    // Passing no build name is what makes xcode apply the property to Debug and
    // Release both. Naming one would leave the other on automatic signing.
    const { project, writes } = createRecordingProject();
    applyManualSigningToTarget(project, 'Kangentic', INPUTS);

    for (const write of writes) {
      expect(write.build).toBeUndefined();
    }
  });

  it('quotes each value, because pbxproj distinguishes a bare token', () => {
    const { project, writes } = createRecordingProject();
    applyManualSigningToTarget(project, 'Kangentic', INPUTS);

    const byProperty = new Map(writes.map((write) => [write.property, write.value]));
    expect(byProperty.get('CODE_SIGN_STYLE')).toBe('"Manual"');
    expect(byProperty.get('DEVELOPMENT_TEAM')).toBe(`"${INPUTS.teamId}"`);
    expect(byProperty.get('PROVISIONING_PROFILE_SPECIFIER')).toBe(`"${INPUTS.profileUuid}"`);
    // The certificate SHA-1, never its common name: on an individual Apple
    // account that name is a person's legal name, and CI logs here are public.
    expect(byProperty.get('CODE_SIGN_IDENTITY')).toBe(`"${INPUTS.signingIdentity}"`);
  });
});

/**
 * The defect that shipped a broken v0.6.3 iOS build, pinned against the real
 * library's storage rather than against what the plugin wished were true.
 *
 * `xcode`'s `addTarget` stores a target's name QUOTED (pbxProject.js:1489) and
 * writes that verbatim as the section comment (:574), while `pbxTargetByName`
 * compares the comment to the raw string (:1031). So a target created by
 * `addTarget` cannot be found by its own unquoted name - and
 * `updateBuildProperty` responds to an unfound target by writing NOTHING and
 * returning normally, which is why the extension reached an archive carrying
 * the app's provisioning profile with every check green.
 *
 * The fakes below reproduce BOTH storage shapes deliberately. Modelling only
 * one is what the previous version of this file did (it never modelled
 * pbxTargetByName at all, only the write call's argument shape), and a test
 * that mirrors the plugin's assumption instead of the library's behaviour
 * cannot catch a mismatch between them.
 */
describe('resolveStoredTargetName', () => {
  function lookupOver(storedNames: string[]) {
    return {
      pbxTargetByName(name: string) {
        return storedNames.includes(name) ? { isa: 'PBXNativeTarget' } : null;
      },
    };
  }

  it('finds a prebuild-created target, whose name is stored unquoted', () => {
    // The app target. This is the path that always worked, and its working is
    // exactly what hid the extension being broken.
    expect(resolveStoredTargetName(lookupOver(['Kangentic']), 'Kangentic')).toBe('Kangentic');
  });

  it('finds an addTarget-created target, whose name is stored QUOTED', () => {
    // The extension. Without this the lookup returns null and the signing write
    // silently no-ops.
    expect(resolveStoredTargetName(lookupOver(['"KangenticNSE"']), 'KangenticNSE')).toBe('"KangenticNSE"');
  });

  it('returns null when no target matches either spelling, so the caller can refuse rather than no-op', () => {
    expect(resolveStoredTargetName(lookupOver(['SomethingElse']), 'KangenticNSE')).toBeNull();
  });

  it('prefers the unquoted spelling when both somehow exist', () => {
    const resolved = resolveStoredTargetName(lookupOver(['Kangentic', '"Kangentic"']), 'Kangentic');
    expect(resolved).toBe('Kangentic');
  });
});
