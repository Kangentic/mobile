/**
 * Guards the build workflows against the ways they can silently rot.
 *
 * The Android workflow builds with Gradle rather than `eas build`, so eas.json is
 * no longer read by the build tool itself. That is a deliberate trade (see the CI
 * builds section of docs/developer-guide.md), and these tests are what keeps it
 * honest: the workflow's profile list must stay equal to eas.json's, which is
 * the EAS profile anchor named in .claude/rules/docs-stay-in-sync.md.
 *
 * The release-gate groups cover the safety gates on the Play submit job and the
 * iOS upload step. Those are the difference between "a release needs a
 * deliberate decision" and "a release happens because someone clicked Run
 * workflow".
 *
 * The iOS group additionally locks two orderings and one logging rule that are
 * each load bearing and none of which any other check would catch.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflowPath = `${repositoryRoot}.github/workflows/build-android.yml`;
const iosWorkflowPath = `${repositoryRoot}.github/workflows/build-ios.yml`;
const easProfileScript = `${repositoryRoot}scripts/easProfile.mjs`;
const androidAbisScript = `${repositoryRoot}scripts/androidAbis.mjs`;

const workflowSource = readFileSync(workflowPath, 'utf8');
const iosWorkflowSource = readFileSync(iosWorkflowPath, 'utf8');

function readIosScript(name: string): string {
  return readFileSync(`${repositoryRoot}.github/scripts/${name}`, 'utf8');
}

/**
 * The section of build-ios.yml belonging to one job. Ordering assertions need
 * this: `expo prebuild --platform ios` appears in both the simulator and the
 * device job, so a whole-file indexOf silently compares against the wrong one.
 */
function readIosJob(jobName: string): string {
  const start = iosWorkflowSource.indexOf(`\n  ${jobName}:\n`);
  expect(start).toBeGreaterThan(-1);
  const nextJob = iosWorkflowSource.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return nextJob === -1 ? iosWorkflowSource.slice(start) : iosWorkflowSource.slice(start, start + 1 + nextJob);
}

interface EasConfig {
  build: Record<string, { extends?: string; channel?: string; distribution?: string }>;
}

const easConfig = JSON.parse(readFileSync(`${repositoryRoot}eas.json`, 'utf8')) as EasConfig;

/**
 * Pull the `profile` dispatch input's choice list out of the workflow. Parsed
 * as text on purpose: a YAML dependency would be a new package in the lockfile
 * for one assertion.
 */
function readWorkflowProfileChoices(): string[] {
  const lines = workflowSource.split('\n');
  const profileKeyIndex = lines.findIndex((line) => line === '      profile:');
  expect(profileKeyIndex).toBeGreaterThan(-1);

  const optionsKeyIndex = lines.findIndex((line, index) => index > profileKeyIndex && line === '        options:');
  expect(optionsKeyIndex).toBeGreaterThan(-1);

  const choices: string[] = [];
  for (let index = optionsKeyIndex + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^ {10}- ([\w-]+)$/);
    if (!match) {
      break;
    }
    choices.push(match[1]);
  }
  return choices;
}

function runScript(scriptPath: string, scriptArguments: string[]): string {
  return execFileSync(process.execPath, [scriptPath, ...scriptArguments], {
    encoding: 'utf8',
    cwd: repositoryRoot,
  }).trim();
}

function runEasProfileScript(scriptArguments: string[]): string {
  return runScript(easProfileScript, scriptArguments);
}

describe('build-android workflow and eas.json parity', () => {
  it('offers exactly the build profiles eas.json declares, plus "all"', () => {
    const choices = readWorkflowProfileChoices();
    // "all" fans every profile out across runners in parallel; it is a
    // selection mode, not an eas.json profile.
    expect(choices).toContain('all');
    expect(choices.filter((choice) => choice !== 'all').sort()).toEqual(Object.keys(easConfig.build).sort());
  });

  it('gives every eas.json profile a default ABI list', () => {
    // A profile with no ABI default would throw at build time, on the runner,
    // after npm ci and prebuild have already run.
    const profilesWithAbiDefaults = runScript(androidAbisScript, ['--profiles']).split('\n');
    expect(profilesWithAbiDefaults.sort()).toEqual(Object.keys(easConfig.build).sort());
  });

  it('gives the e2e profile an emulator-installable ABI', () => {
    // The Maestro paired suite runs on a standard emulator image, which is
    // x86_64. An arm64-only APK builds and uploads fine and then fails at
    // `adb install` with an unhelpful error.
    expect(runScript(androidAbisScript, ['e2e'])).toContain('x86_64');
  });

  it('builds every ABI for production, since Play splits per device', () => {
    const productionAbis = runScript(androidAbisScript, ['production']).split(',');
    expect(productionAbis.sort()).toEqual(['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']);
  });

  it('verifies the artifact ABIs rather than trusting the Gradle flag', () => {
    expect(workflowSource).toContain('verify-android-abis.sh');
  });

  it('sources the profile env from eas.json rather than duplicating it in YAML', () => {
    expect(workflowSource).toContain('scripts/easProfile.mjs');
    // If the flag were ever inlined into the workflow, eas.json would stop
    // being authoritative for it and the two could drift apart unnoticed.
    expect(workflowSource).not.toContain('EXPO_PUBLIC_KANGENTIC_E2E');
    expect(easConfig.build.e2e).toBeDefined();
  });

  it('generates the native project instead of expecting a committed one', () => {
    // .claude/rules/expo-cng.md: android/ is a prebuild artifact.
    expect(workflowSource).toContain('expo prebuild --platform android --no-install');
  });

  it('exports the profile env before prebuild, not just before Gradle', () => {
    // app.config.ts reads EXPO_PUBLIC_KANGENTIC_E2E at config-evaluation time
    // to set android usesCleartextTraffic, and that evaluation happens during
    // prebuild. GITHUB_ENV only affects LATER steps, so exporting after
    // prebuild would produce an e2e APK that builds green but ships without the
    // cleartext manifest entry, and the Maestro paired suite would then fail at
    // relay connect (code 1006) with nothing in the build log to explain it.
    const exportIndex = workflowSource.indexOf('Export the profile env from eas.json');
    const prebuildIndex = workflowSource.indexOf('expo prebuild --platform android');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(prebuildIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(prebuildIndex);
  });

  it('exports the Sentry env before prebuild, for the same GITHUB_ENV reason', () => {
    // app.config.ts reads SENTRY_AUTH_TOKEN at config-evaluation time to decide
    // whether to include the Sentry plugin at all. Exporting after prebuild
    // would produce a build that reports crashes but has no source maps
    // uploaded, so every stack trace arrives minified and useless - green
    // build, worthless symbolication.
    const exportIndex = workflowSource.indexOf('Export the Sentry build env');
    const prebuildIndex = workflowSource.indexOf('expo prebuild --platform android');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(prebuildIndex);
  });

  it('keeps the Sentry DSN out of the committed config, as a variable not a secret', () => {
    // The repo is public and the Sentry project is on the free tier (5k
    // errors/month). A DSN committed to eas.json or the workflow would route
    // every fork's crashes into this project's quota. That is the reason it is
    // injected rather than committed - NOT confidentiality: a DSN ships inside
    // the published app bundle and is write-only. So it is a repository
    // VARIABLE, which can be read back to verify which project is wired; a
    // secret cannot, and a mistyped one would be undetectable.
    expect(workflowSource).toContain('vars.SENTRY_DSN');
    expect(workflowSource).not.toContain('secrets.SENTRY_DSN');
    expect(workflowSource).not.toMatch(/https:\/\/[0-9a-f]+@[a-z0-9.]*ingest/);
    const easSource = readFileSync(`${repositoryRoot}eas.json`, 'utf8');
    expect(easSource).not.toContain('SENTRY');
  });

  it('masks the Sentry auth token but not the DSN', () => {
    // The token can upload releases, so it is masked. Masking the DSN would
    // cost the one diagnostic the log is good for - which project a build
    // reported to - and buy nothing, since the value ships in the bundle.
    expect(workflowSource).toContain('::add-mask::$SENTRY_AUTH_TOKEN');
    expect(workflowSource).not.toContain('::add-mask::$SENTRY_DSN');
  });

  it('exports the crash-test flag before prebuild, for the same GITHUB_ENV reason', () => {
    // EXPO_PUBLIC_KANGENTIC_CRASHTEST is inlined by Metro when the bundle is
    // built. Unlike SENTRY_AUTH_TOKEN, app.config.ts does NOT read this one
    // (nothing in it references CRASHTEST) - the ordering requirement comes
    // purely from the bundling step that prebuild sets up, so do not go
    // looking for a config-evaluation reference that does not exist.
    // Exporting after prebuild would ship a build where Settings never
    // reveals the crash-test rows.
    const exportIndex = workflowSource.indexOf('Export the crash-test flag');
    const prebuildIndex = workflowSource.indexOf('expo prebuild --platform android');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(prebuildIndex);
  });

  it('keeps the crash-test flag out of eas.json and off by default', () => {
    // Same fork-quota reasoning as the Sentry export: dispatch-only, never
    // committed, defaults to false so a store-track build never carries it.
    //
    // Parsed rather than substring-matched: `toContain('default: false')` is
    // green as long as ANY input in the file defaults to false, so a second
    // boolean input would let crash_test's default silently flip to true
    // while this still passed. A check that cannot fire is worse than none
    // (.claude/rules/crash-reporting-scope.md).
    const workflow = parseYaml(workflowSource) as {
      on: { workflow_dispatch: { inputs: Record<string, { default?: unknown }> } };
    };
    expect(workflow.on.workflow_dispatch.inputs.crash_test.default).toBe(false);
    const easSource = readFileSync(`${repositoryRoot}eas.json`, 'utf8');
    expect(easSource).not.toContain('CRASHTEST');
  });

  it('forces the crash-test flag off on a tag build regardless of a stale dispatch input', () => {
    expect(workflowSource).toContain("CRASH_TEST: ${{ github.event_name != 'push' && inputs.crash_test == true }}");
  });

  it('refuses a crash-test build that also asks for a store submission', () => {
    // The CRASH_TEST expression only excludes a `push` (tag) build, but a tag
    // is not this project's release path - CLAUDE.md documents a DISPATCH with
    // `-f submit_track=internal`. Without this, one dispatch carrying both
    // crash_test and a real submit_track would upload a build with a
    // Sentry.nativeCrash() button in Settings to a live Play track.
    const workflow = parseYaml(workflowSource) as {
      on: { workflow_dispatch: { inputs: Record<string, { default?: unknown }> } };
      jobs: Record<string, { if?: string; steps?: { name?: string; if?: string }[] }>;
    };

    // The refusal below compares against the literal 'none', so it only stays
    // a targeted guard while that is the default. If the default became ''
    // the condition would be true on every ordinary dispatch and refuse every
    // crash-test build - the affordance would silently stop existing.
    expect(workflow.on.workflow_dispatch.inputs.submit_track.default).toBe('none');

    const refusal = workflow.jobs.plan.steps?.find((step) =>
      step.name === 'Refuse a crash-test build that is also a store submission'
    );
    expect(refusal?.if).toBe("inputs.crash_test == true && inputs.submit_track != 'none'");

    // And the submit job itself will not run for a crash-test build even if
    // the refusal above were ever removed.
    expect(workflow.jobs['submit-play'].if).toContain('inputs.crash_test != true');
  });
});

describe('build-android release safety gates', () => {
  it('never submits to Play unless a track was explicitly chosen', () => {
    expect(workflowSource).toContain("inputs.submit_track != 'none'");
  });

  it('puts the submit job behind a protected environment', () => {
    expect(workflowSource).toContain('environment: google-play');
  });

  it('verifies the signature in both the build and the submit job', () => {
    // The submit job re-verifies what it downloaded rather than trusting a job
    // output from the build. That is both stronger and necessary: matrix job
    // outputs are not per-instance addressable, so a trusted output would be
    // whichever matrix leg happened to finish last.
    const occurrences = workflowSource.split('verify-android-signature.sh').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('checks the version code against Play before uploading', () => {
    expect(workflowSource).toContain('scripts/checkPlayVersionCode.mjs');
  });

  it('preflights the version code in the plan job, before anything is built', () => {
    // The submit job checks too, but it carries `environment: google-play` and
    // its check is a step INSIDE that job, so it runs after a ~25 minute build
    // AND after a human approval. On 2026-07-28 that ordering meant a spent
    // counter was only discovered once both had already been spent. iOS always
    // checked before its archive; this closes the asymmetry.
    const workflow = parseYaml(workflowSource) as {
      jobs: Record<
        string,
        { needs?: string | string[]; steps?: { name?: string; if?: string; run?: string }[] }
      >;
    };

    const preflight = workflow.jobs.plan.steps?.find(
      (step) => step.name === 'Check the version code is free on every track'
    );
    expect(preflight?.run).toContain('scripts/checkPlayVersionCode.mjs');
    expect(preflight?.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.submit_track != 'none'"
    );

    // The preflight only helps if nothing can build past a failing plan job.
    expect(workflow.jobs['build-android'].needs).toBe('plan');
  });

  it('still re-checks the version code in the submit job', () => {
    // Not redundant with the plan-job preflight. This one closes the window
    // between planning and submitting, in which a release cut from another
    // machine could take the number.
    const occurrences = workflowSource.split('scripts/checkPlayVersionCode.mjs').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('caps artifact retention so storage does not accrue', () => {
    expect(workflowSource).toMatch(/retention-days: \d+/);
  });
});

describe('build-ios workflow', () => {
  it('keeps the unsigned simulator check as its own job', () => {
    // Not a matrix dimension of the signed build. The simulator check needs no
    // Apple account and is the only iOS signal available when signing material
    // is missing or expired, so a signing problem must not be able to take it
    // down with it.
    expect(iosWorkflowSource).toMatch(/^ {2}simulator:$/m);
    expect(iosWorkflowSource).toMatch(/^ {2}device:$/m);
  });

  it('generates the native project instead of expecting a committed one', () => {
    // .claude/rules/expo-cng.md: ios/ is a prebuild artifact.
    expect(iosWorkflowSource).toContain('expo prebuild --platform ios --no-install');
  });

  it('resolves the scheme through the shared script in both jobs', () => {
    // Taking schemes[0] from `xcodebuild -list` once built a CocoaPods scheme
    // and reported success without compiling any app code. Both jobs must use
    // the same resolution so they cannot disagree about what they build.
    const occurrences = iosWorkflowSource.split('resolve-ios-scheme.sh').length - 1;
    expect(occurrences).toBe(2);
  });

  it('installs pods before anything reads the workspace', () => {
    // The .xcworkspace is a CocoaPods artifact and does not exist until
    // pod install completes, so resolving the scheme first finds nothing.
    const podInstallIndex = iosWorkflowSource.indexOf('working-directory: ios');
    const resolveIndex = iosWorkflowSource.indexOf('resolve-ios-scheme.sh');
    expect(podInstallIndex).toBeGreaterThan(-1);
    expect(podInstallIndex).toBeLessThan(resolveIndex);
  });

  it('preflights the build number before spending an archive', () => {
    // A duplicate build number is rejected by App Store Connect, and finding
    // that out after a 30 minute archive is the Android versionCode lesson
    // repeated on a slower platform.
    const preflightIndex = iosWorkflowSource.indexOf('scripts/checkAppStoreBuild.mjs');
    const archiveIndex = iosWorkflowSource.indexOf('xcodebuild archive');
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(archiveIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeLessThan(archiveIndex);
  });

  it('verifies the .ipa signature in both the build and the submit job', () => {
    // The submit job re-verifies what it downloaded rather than trusting the
    // build job. Same reasoning as the Android submit path, which caught a bad
    // artifact twice.
    const occurrences = iosWorkflowSource.split('verify-ios-signature.sh').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);

    const verifyIndex = iosWorkflowSource.indexOf('verify-ios-signature.sh');
    const uploadIndex = iosWorkflowSource.indexOf('upload-ios-testflight.sh');
    expect(uploadIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeLessThan(uploadIndex);
  });

  it('stores the artifact before attempting the upload', () => {
    // So an Apple-side failure leaves a verified .ipa that can be retried by
    // re-running the submit job alone. Not hypothetical: the first attempt to
    // submit this app hit an App Store Connect outage.
    //
    // Matched WITHOUT the version pin. This assertion used to search for
    // `actions/upload-artifact@v4` and broke the moment the action was bumped,
    // reporting "expected -1 to be greater than -1" - which reads like the
    // upload step vanished rather than like a version changed. The ordering is
    // what this test is about; the version is somebody else's business.
    const artifactIndex = iosWorkflowSource.search(/actions\/upload-artifact@v\d+/);
    const uploadIndex = iosWorkflowSource.indexOf('upload-ios-testflight.sh');
    expect(artifactIndex).toBeGreaterThan(-1);
    expect(artifactIndex).toBeLessThan(uploadIndex);
  });

  it('never uploads to Apple unless the dispatch asked for it', () => {
    // Asserted against the submit job's condition rather than a whole-file literal,
    // so tightening the condition (as the schedule trigger required) does not read
    // as a regression.
    expect(readIosJob('submit-testflight')).toContain("inputs.submit == 'testflight'");
  });

  it('puts the upload behind a protected environment, like the Play submit', () => {
    // An upload reaches people outside this machine, so it takes a human
    // approval rather than a dispatch input alone.
    expect(iosWorkflowSource).toContain('environment: app-store-connect');
    expect(iosWorkflowSource).toMatch(/^ {2}submit-testflight:$/m);
  });

  it('uploads from a macOS runner, since altool is the uploader', () => {
    // A cheaper ubuntu runner has no xcrun, and the failure would be an opaque
    // "command not found" after the artifact download.
    const submitJobIndex = iosWorkflowSource.indexOf('submit-testflight:');
    const submitJob = iosWorkflowSource.slice(submitJobIndex);
    expect(submitJob).toContain('runs-on: macos-latest');
  });

  it('derives the team id and profile from the profile, never a literal', () => {
    // The Apple team name is a personal name on an individual account
    // (.claude/rules/no-personal-info.md), and the EAS-issued profile name
    // embeds a timestamp that changes on every reissue, so a literal would both
    // leak and rot.
    expect(iosWorkflowSource).toContain('steps.signing.outputs.team-id');
    expect(iosWorkflowSource).toContain('steps.signing.outputs.profile-uuid');
    expect(iosWorkflowSource).not.toMatch(/DEVELOPMENT_TEAM=["']?[A-Z0-9]{10}["']?/);
  });

  it('keeps signing material out of a public log', () => {
    // This repository is public, so Actions logs are public. `codesign -dvv` and
    // `security find-identity` both print the certificate common name, which is
    // a person's legal name on an individual Apple Developer account. Both
    // scripts must capture that output and match against it, never cat it.
    for (const scriptName of ['install-ios-signing.sh', 'verify-ios-signature.sh']) {
      const source = readIosScript(scriptName);
      expect(source).toContain('no-personal-info.md');
      expect(source).not.toMatch(/^\s*(cat|echo)\s+"?\$(identities|signing_info)/m);
    }
  });

  it('accepts both App Store certificate types', () => {
    // Apple issues two and has retired neither: the newer unified "Apple
    // Distribution" and the older iOS-only "iPhone Distribution", which is what
    // `eas credentials` actually issues. Matching only the newer name rejected a
    // perfectly good certificate on the first real run.
    for (const scriptName of ['install-ios-signing.sh', 'verify-ios-signature.sh']) {
      const source = readIosScript(scriptName);
      expect(source).toContain('iPhone Distribution');
      expect(source).toContain('Apple Distribution');
    }
  });

  it('signs against the certificate SHA-1, not its name', () => {
    // Sidesteps the two-names problem entirely, and unlike the common name a
    // hash is not a person's legal name in a public log.
    expect(iosWorkflowSource).toContain('steps.signing.outputs.signing-identity');
    expect(readIosScript('export-ios-ipa.sh')).toContain('<string>$SIGNING_IDENTITY</string>');
  });

  it('scopes signing to the app target instead of the xcodebuild command line', () => {
    // Command-line build settings apply to EVERY target, and one that produces
    // no signed bundle rejects a provisioning profile outright. The first signed
    // archive died on a Swift Package target for exactly this reason.
    expect(iosWorkflowSource).not.toMatch(/xcodebuild archive[\s\S]{0,900}PROVISIONING_PROFILE_SPECIFIER=/);
    expect(iosWorkflowSource).not.toMatch(/xcodebuild archive[\s\S]{0,900}CODE_SIGN_STYLE=/);
    expect(iosWorkflowSource).toContain('KANGENTIC_IOS_PROFILE_UUID');
  });

  it('exports the signing inputs before prebuild, not just before the archive', () => {
    // withIosManualSigning runs during prebuild, and GITHUB_ENV only affects
    // LATER steps, so exporting late leaves the generated project on automatic
    // signing. Identical in shape to the eas.json env ordering on Android, and
    // identically silent when wrong.
    const deviceJob = readIosJob('device');
    const exportIndex = deviceJob.indexOf('Export the signing inputs for the config plugin');
    const prebuildIndex = deviceJob.indexOf('expo prebuild --platform ios');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(prebuildIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(prebuildIndex);
  });

  it('sources the profile env from eas.json, like the Android build does', () => {
    // Without this, an EXPO_PUBLIC_* value added to an eas.json profile reaches an
    // Android build and silently not an iOS one. Nobody notices until a feature
    // flag is inexplicably off on one platform.
    const deviceJob = readIosJob('device');
    const exportIndex = deviceJob.indexOf('scripts/easProfile.mjs');
    const prebuildIndex = deviceJob.indexOf('expo prebuild --platform ios');
    expect(exportIndex).toBeGreaterThan(-1);
    // Same ordering requirement as Android: app.config.ts reads EXPO_PUBLIC_* at
    // config-evaluation time, which happens during prebuild.
    expect(exportIndex).toBeLessThan(prebuildIndex);
  });

  it('exports the Sentry env before prebuild on iOS too', () => {
    // Android and iOS drifting apart on a build-time value is a documented
    // failure mode in this workflow pair (see the eas.json case above).
    const deviceJob = readIosJob('device');
    const exportIndex = deviceJob.indexOf('Export the Sentry build env');
    const prebuildIndex = deviceJob.indexOf('expo prebuild --platform ios');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(prebuildIndex);
  });

  it('gates native config on BOTH platforms, not just Android', () => {
    // Prebuilding only Android is what let a broken config-plugin import reach an
    // iOS build while every PR check stayed green.
    const ciSource = readFileSync(`${repositoryRoot}.github/workflows/ci.yml`, 'utf8');
    expect(ciSource).toContain('expo prebuild --platform android');
    expect(ciSource).toContain('expo prebuild --platform ios');
  });

  it('surfaces the generated iOS privacy manifest as an artifact, and fails rather than warns if it is missing', () => {
    // PrivacyInfo.xcprivacy is a prebuild artifact, so this upload is the only
    // way to read what the app actually declares to Apple without a signed
    // build. `if-no-files-found: error` is the load-bearing half: downgraded to
    // `warn`, a manifest that stopped generating would leave the job green and
    // the declaration unverifiable, which is the exact failure the step exists
    // to catch. The glob matches ios/<projectName>/, which is ios/Kangentic/
    // for `name: 'Kangentic'` in app.config.ts.
    const ciSource = readFileSync(`${repositoryRoot}.github/workflows/ci.yml`, 'utf8');
    expect(ciSource).toContain('name: ios-privacy-manifest');
    expect(ciSource).toContain('path: ios/*/PrivacyInfo.xcprivacy');
    expect(ciSource).toContain('if-no-files-found: error');
  });

  it('asserts the app target actually got manual signing', () => {
    // The plugin is inert without its environment variables, and a silently
    // unsigned archive is the failure mode this workflow exists to prevent.
    const deviceJob = readIosJob('device');
    const assertIndex = deviceJob.indexOf('-showBuildSettings');
    const archiveIndex = deviceJob.indexOf('xcodebuild archive');
    expect(assertIndex).toBeGreaterThan(-1);
    expect(archiveIndex).toBeGreaterThan(-1);
    expect(assertIndex).toBeLessThan(archiveIndex);
  });

  it('fails a build whose entitlements lost push', () => {
    // A re-sign that drops aps-environment yields an app that installs,
    // launches, and silently never receives a notification. Push is the reason
    // this app exists, so this is fatal rather than a warning.
    const verifySource = readIosScript('verify-ios-signature.sh');
    expect(verifySource).toContain('aps-environment');
    expect(verifySource).toContain('could not receive push');
  });

  it('supports both App Store Connect auth mechanisms', () => {
    // An ASC API key is preferred, but minting one needs App Store Connect's
    // Users and Access page, which is exactly what fails during an ASC
    // incident. An app-specific password comes from appleid.apple.com instead.
    const uploadSource = readIosScript('upload-ios-testflight.sh');
    expect(uploadSource).toContain('--apiKey');
    expect(uploadSource).toContain('--apiIssuer');
    expect(uploadSource).toContain('--username');
  });

  it('caps artifact retention so storage does not accrue', () => {
    expect(iosWorkflowSource).toMatch(/retention-days: \d+/);
  });

  it('never signs or uploads on the weekly schedule', () => {
    // The trap: `inputs` are all empty on a schedule, so `inputs.target != 'device'`
    // and `inputs.target != 'simulator'` are BOTH true on a cron run. Left to input
    // defaults, the drift check would quietly fire a signed device build every
    // Monday, and with submit wired it could have uploaded one.
    expect(iosWorkflowSource).toContain('schedule:');
    expect(readIosJob('device')).toContain("github.event_name != 'schedule'");
    expect(readIosJob('submit-testflight')).toContain("github.event_name != 'schedule'");
    // And the cheap check must still run, or the schedule detects nothing.
    expect(readIosJob('simulator')).toContain("github.event_name == 'schedule'");
  });
});

describe('workflow env-gated steps are defined in their own job', () => {
  // `env` does not cross a job boundary. A step gated on `env.FOO` in a job that
  // never declares FOO does not error: the condition is simply false and the step
  // SKIPS, while the job still reports success.
  //
  // That is not hypothetical. `submit-testflight` gated its "Wait for Apple to
  // accept the build" step on HAS_ASC_API_KEY, which was declared only on the
  // `device` job. The step skipped on every run, the job went green, and a build
  // Apple had rejected passed for a successful release - the exact failure the step
  // was written to catch.
  //
  // Parsed with the yaml package that is already a transitive dependency, because
  // this needs job structure rather than a text match.
  const workflowFiles = ['build-ios.yml', 'build-android.yml', 'ci.yml', 'e2e.yml'];

  it.each(workflowFiles)('%s gates steps only on env its job defines', (workflowFile) => {
    const source = readFileSync(`${repositoryRoot}.github/workflows/${workflowFile}`, 'utf8');
    const workflow = parseYaml(source) as {
      env?: Record<string, unknown>;
      jobs: Record<string, { env?: Record<string, unknown>; steps?: { if?: string }[] }>;
    };

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const declared = new Set([
        ...Object.keys(workflow.env ?? {}),
        ...Object.keys(job.env ?? {}),
      ]);

      for (const step of job.steps ?? []) {
        for (const match of (step.if ?? '').matchAll(/env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
          expect(
            declared.has(match[1]),
            `${workflowFile}: job "${jobName}" gates a step on env.${match[1]}, which that job does not define. ` +
              'The step will silently skip and the job will still pass.'
          ).toBe(true);
        }
      }
    }
  });
});

describe('build-android staged rollout', () => {
  it('keeps the rollout and full-release uploads as separate steps', () => {
    // `userFraction` is only valid with an inProgress status; Play rejects it
    // alongside `completed`. One step with interpolated values would be a silent
    // misconfiguration, so they are two mutually exclusive steps.
    expect(workflowSource).toContain('status: inProgress');
    expect(workflowSource).toContain('status: completed');
    expect(workflowSource).toContain("if: inputs.rollout != ''");
    expect(workflowSource).toContain("if: inputs.rollout == ''");
  });

  it('defaults to a full release rather than a surprise partial one', () => {
    // An empty default means an unqualified dispatch behaves as it always has.
    // A staged rollout has to be asked for, because an unfinished rollout that
    // nobody completes is its own failure mode.
    expect(workflowSource).toMatch(/rollout:[\s\S]{0,200}default: ''/);
  });

  it('refuses an unstaged release to a track with real users', () => {
    // A `completed` Play release can never be pulled back, only superseded by a
    // higher version code, so releasing to alpha or beta without a staged
    // rollout is irreversible the moment it lands. That used to be a prose rule
    // in .claude/skills/release/SKILL.md telling the operator to pass
    // `-f rollout=0.1`, which is the kind of rule that holds right up until
    // somebody is in a hurry.
    //
    // `internal` is deliberately NOT covered: the track is small and known, and
    // the documented recovery there is simply shipping a higher version code.
    const workflow = parseYaml(workflowSource) as {
      jobs: Record<string, { steps?: { name?: string; if?: string }[] }>;
    };
    const refusal = workflow.jobs.plan.steps?.find(
      (step) => step.name === 'Refuse an unstaged release to a track with real users'
    );
    expect(refusal?.if).toBe(
      "(inputs.submit_track == 'alpha' || inputs.submit_track == 'beta') && inputs.rollout == ''"
    );
  });
});

describe('spent release counters are recorded mechanically', () => {
  // Before this, the only record of which counters were spent was a hand-edited
  // comment in app.config.ts. That comment is true when written and rots in
  // silence: a stale "builds 1 and 2 are spent, hence 3" sent the 2026-07-28
  // iOS release at a build number Apple had already taken. A tag cannot drift.
  it('tags the spent version code after the Play upload, and never fails the release for it', () => {
    const workflow = parseYaml(workflowSource) as {
      jobs: Record<
        string,
        {
          permissions?: Record<string, string>;
          steps?: { name?: string; 'continue-on-error'?: boolean }[];
        }
      >;
    };
    const steps = workflow.jobs['submit-play'].steps ?? [];
    const uploadIndex = steps.findIndex(
      (step) => step.name === 'Upload to Google Play (full release)'
    );
    const tagIndex = steps.findIndex(
      (step) => step.name === 'Record the spent version code as a tag'
    );
    expect(uploadIndex).toBeGreaterThanOrEqual(0);
    expect(tagIndex).toBeGreaterThan(uploadIndex);

    // The upload cannot be undone, so a bookkeeping failure must not redden a
    // release that already reached Play.
    expect(steps[tagIndex]?.['continue-on-error']).toBe(true);

    // Creating a ref needs more than the workflow's top-level `contents: read`.
    expect(workflow.jobs['submit-play'].permissions?.contents).toBe('write');
  });

  it('tags the spent build number only after Apple accepts, not merely after upload', () => {
    const workflow = parseYaml(iosWorkflowSource) as {
      jobs: Record<
        string,
        {
          permissions?: Record<string, string>;
          steps?: { name?: string; 'continue-on-error'?: boolean }[];
        }
      >;
    };
    const steps = workflow.jobs['submit-testflight'].steps ?? [];
    const acceptIndex = steps.findIndex((step) => step.name === 'Wait for Apple to accept the build');
    const tagIndex = steps.findIndex(
      (step) => step.name === 'Record the spent build number as a tag'
    );
    expect(acceptIndex).toBeGreaterThanOrEqual(0);

    // Ordering is the whole point. Builds 1 and 2 both reported UPLOAD
    // SUCCEEDED and were then refused by Apple, so a tag written at upload time
    // would record a build that never reached a tester.
    expect(tagIndex).toBeGreaterThan(acceptIndex);
    expect(steps[tagIndex]?.['continue-on-error']).toBe(true);
    expect(workflow.jobs['submit-testflight'].permissions?.contents).toBe('write');
  });

  it('preflights a changed counter on every pull request', () => {
    const ciSource = readFileSync(`${repositoryRoot}.github/workflows/ci.yml`, 'utf8');
    const ci = parseYaml(ciSource) as {
      jobs: Record<string, { if?: string; steps?: { name?: string; run?: string }[] }>;
    };
    const job = ci.jobs['release-counters'];
    expect(job).toBeDefined();
    expect(job.if).toBe("github.event_name == 'pull_request'");

    const runs = (job.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(runs).toContain('scripts/checkPlayVersionCode.mjs');
    expect(runs).toContain('scripts/checkAppStoreBuild.mjs');
  });
});

describe('easProfile.mjs profile resolution', () => {
  it('lists every eas.json build profile', () => {
    expect(runEasProfileScript(['--list']).split('\n')).toEqual(Object.keys(easConfig.build));
  });

  it('resolves the extends chain and merges env', () => {
    const resolved = JSON.parse(runEasProfileScript(['e2e', '--json']));
    expect(resolved.env.EXPO_PUBLIC_KANGENTIC_E2E).toBe('1');
    // Inherited from the preview profile it extends.
    expect(resolved.distribution).toBe('internal');
    // Overridden on the child.
    expect(resolved.channel).toBe('e2e');
    // The directive itself is not part of the resolved profile.
    expect(resolved.extends).toBeUndefined();
  });

  it('reads a dotted field, which is how the workflow picks the Gradle task', () => {
    expect(runEasProfileScript(['e2e', '--field', 'android.buildType'])).toBe('apk');
    expect(runEasProfileScript(['development', '--field', 'android.buildType'])).toBe('apk');
  });

  it('fails loudly on an unknown profile', () => {
    expect(() => runEasProfileScript(['does-not-exist', '--json'])).toThrow();
  });

  it('writes the profile env in GITHUB_ENV format', () => {
    // The workflow relies on this exact shape to get EXPO_PUBLIC_* values into
    // the Gradle step, where Metro inlines them into the bundle. A silent
    // change here would produce an e2e APK without its flag set.
    const githubEnvPath = join(mkdtempSync(join(tmpdir(), 'kangentic-github-env-')), 'github-env');
    writeFileSync(githubEnvPath, '');

    execFileSync(process.execPath, [easProfileScript, 'e2e', '--github-env'], {
      cwd: repositoryRoot,
      env: { ...process.env, GITHUB_ENV: githubEnvPath },
      encoding: 'utf8',
    });
    expect(readFileSync(githubEnvPath, 'utf8')).toBe('EXPO_PUBLIC_KANGENTIC_E2E=1\n');

    // A profile with no env block must contribute nothing rather than a blank line.
    writeFileSync(githubEnvPath, '');
    execFileSync(process.execPath, [easProfileScript, 'preview', '--github-env'], {
      cwd: repositoryRoot,
      env: { ...process.env, GITHUB_ENV: githubEnvPath },
      encoding: 'utf8',
    });
    expect(readFileSync(githubEnvPath, 'utf8')).toBe('');
  });
});
