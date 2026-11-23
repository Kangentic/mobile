/**
 * Covers scripts/checkIosSdk.mjs, the SDK floor that build-ios.yml checks on
 * every built app (through .github/scripts/verify-ios-sdk.sh).
 *
 * It exists because of ITMS-90725. v1.5.1 build 25 and v1.6.0 build 26 were built
 * on `macos-latest` with the iOS 26.5 SDK, and the only signal was Apple's email
 * after each upload. From April 2027 App Store Connect refuses such an upload, so
 * the regression case below is build 26's own stamps, which must be rejected.
 *
 * The stamps are the three keys Xcode writes into a built app's Info.plist. They
 * reach the script as flags because reading the plist needs macOS's plutil, so the
 * whole decision, CLI included, runs here on any platform.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { evaluateIosSdk, MINIMUM_IOS_SDK_MAJOR } from '../../scripts/checkIosSdk.mjs';
import { resolveBashExecutable } from '../helpers/bash';

const scriptPath = fileURLToPath(new URL('../../scripts/checkIosSdk.mjs', import.meta.url));
// Forward slashes: bash eats the separators of a backslash path argument.
const harnessPath = fileURLToPath(
  new URL('./fixtures/runSdkCheckWithStubbedPlutil.sh', import.meta.url)
).replaceAll('\\', '/');

// Build 26 (run 45114271164): archived with Xcode 26.6 against iPhoneOS26.5.sdk.
const BUILD_26_STAMPS = { sdkName: 'iphoneos26.5', platformVersion: '26.5', xcode: '2660' };
// What the xcode-27 label with IOS_XCODE_VERSION 27.1 should stamp.
const XCODE_27_1_DEVICE_STAMPS = { sdkName: 'iphoneos27.1', platformVersion: '27.1', xcode: '2710' };
const XCODE_27_1_SIMULATOR_STAMPS = { sdkName: 'iphonesimulator27.1', platformVersion: '27.1', xcode: '2710' };

describe('evaluateIosSdk', () => {
  it('holds the floor at the iOS 27 SDK, which is what ITMS-90725 demands from April 2027', () => {
    expect(MINIMUM_IOS_SDK_MAJOR).toBe(27);
  });

  it("rejects build 26's iOS 26.5 SDK and Xcode 26.6", () => {
    const verdict = evaluateIosSdk(BUILD_26_STAMPS);
    expect(verdict.passed).toBe(false);
    expect(verdict.problems.join('\n')).toContain('iOS 26.5 SDK');
    expect(verdict.problems.join('\n')).toContain('Xcode 26.6');
  });

  it('accepts a device build from Xcode 27.1', () => {
    const verdict = evaluateIosSdk(XCODE_27_1_DEVICE_STAMPS);
    expect(verdict.problems).toEqual([]);
    expect(verdict.passed).toBe(true);
    expect(verdict.summary).toContain('Xcode 27.1');
  });

  it('accepts a simulator build from Xcode 27.1, so the weekly compile check is held to the same floor', () => {
    expect(evaluateIosSdk(XCODE_27_1_SIMULATOR_STAMPS).passed).toBe(true);
  });

  it('accepts an SDK above the floor', () => {
    expect(evaluateIosSdk({ sdkName: 'iphoneos28.0', platformVersion: '28.0', xcode: '2800' }).passed).toBe(true);
  });

  it('rejects a missing DTSDKName, because "could not read it" proves nothing', () => {
    const verdict = evaluateIosSdk({ ...XCODE_27_1_DEVICE_STAMPS, sdkName: '' });
    expect(verdict.passed).toBe(false);
    expect(verdict.problems.join('\n')).toContain('no DTSDKName');
  });

  it('rejects an SDK name that is not an iPhone SDK', () => {
    // A Mac Catalyst or visionOS build would carry an SDK name this rule does not
    // cover, and it must not pass merely because its number is high enough.
    const verdict = evaluateIosSdk({ ...XCODE_27_1_DEVICE_STAMPS, sdkName: 'xros27.1' });
    expect(verdict.passed).toBe(false);
    expect(verdict.problems.join('\n')).toContain('"xros27.1"');
  });

  it('rejects an Xcode below the floor even when the SDK name passes', () => {
    // Apple's rule names both: "built with the iOS 27 SDK or later, included in
    // Xcode 27 or later".
    const verdict = evaluateIosSdk({ ...XCODE_27_1_DEVICE_STAMPS, xcode: '2660' });
    expect(verdict.passed).toBe(false);
    expect(verdict.problems.join('\n')).toContain('Xcode 26.6');
  });

  it('rejects a missing or malformed DTXcode', () => {
    expect(evaluateIosSdk({ ...XCODE_27_1_DEVICE_STAMPS, xcode: '' }).problems.join('\n')).toContain('no DTXcode');
    expect(evaluateIosSdk({ ...XCODE_27_1_DEVICE_STAMPS, xcode: '27.1' }).passed).toBe(false);
  });

  it('rejects a missing or non-numeric DTPlatformVersion, each by its own message', () => {
    const missing = evaluateIosSdk({ ...XCODE_27_1_DEVICE_STAMPS, platformVersion: '' });
    expect(missing.passed).toBe(false);
    expect(missing.problems.join('\n')).toContain('no DTPlatformVersion');
    const malformed = evaluateIosSdk({ ...XCODE_27_1_DEVICE_STAMPS, platformVersion: 'abc' });
    expect(malformed.passed).toBe(false);
    expect(malformed.problems.join('\n')).toContain('is not a version number');
  });

  it('rejects a platform version that disagrees with the SDK name', () => {
    const verdict = evaluateIosSdk({ ...XCODE_27_1_DEVICE_STAMPS, platformVersion: '26.5' });
    expect(verdict.passed).toBe(false);
    expect(verdict.problems.join('\n')).toContain('disagrees');
  });

  it('reads a patch release out of DTXcode', () => {
    expect(evaluateIosSdk({ ...XCODE_27_1_DEVICE_STAMPS, xcode: '2711' }).summary).toContain('Xcode 27.1.1');
  });

  it('honours a different floor when one is passed', () => {
    expect(evaluateIosSdk(XCODE_27_1_DEVICE_STAMPS, 28).passed).toBe(false);
    expect(evaluateIosSdk(BUILD_26_STAMPS, 26).passed).toBe(true);
  });
});

interface ScriptRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs a process to completion and captures its exit status and both streams, pass or fail. */
function runCaptured(executable: string, processArguments: string[], environment: NodeJS.ProcessEnv): ScriptRun {
  try {
    const stdout = execFileSync(executable, processArguments, {
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failed.status ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

function runCheck(scriptArguments: string[], environmentOverride: Record<string, string> = {}): ScriptRun {
  // GITHUB_STEP_SUMMARY cleared so a run under CI does not write into the
  // test job's own summary; a test of the summary passes its own file.
  return runCaptured(process.execPath, [scriptPath, ...scriptArguments], {
    ...process.env,
    GITHUB_STEP_SUMMARY: '',
    ...environmentOverride,
  });
}

function stampArguments(stamps: { sdkName: string; platformVersion: string; xcode: string }): string[] {
  return ['--sdk-name', stamps.sdkName, '--platform-version', stamps.platformVersion, '--xcode', stamps.xcode];
}

describe('checkIosSdk.mjs command line', () => {
  it("exits 1 with an annotation naming ITMS-90725 for build 26's stamps", () => {
    const run = runCheck(stampArguments(BUILD_26_STAMPS));
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('::error::');
    expect(run.stdout).toContain('ITMS-90725');
  });

  it('exits 0 for an Xcode 27.1 build', () => {
    const run = runCheck(stampArguments(XCODE_27_1_DEVICE_STAMPS));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('met');
  });

  it('accepts an empty value for a key the plist lacks, and fails on it by name', () => {
    // verify-ios-sdk.sh passes an empty string when plutil finds no key.
    const run = runCheck(stampArguments({ ...XCODE_27_1_DEVICE_STAMPS, sdkName: '' }));
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('no DTSDKName');
  });

  it('refuses a command line missing a stamp, rather than passing it', () => {
    const run = runCheck(['--sdk-name', 'iphoneos27.1', '--xcode', '2710']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Missing --platform-version');
  });

  it.each(['sdk-name', 'platform-version', 'xcode'])('names --%s when only that flag is missing', (omittedFlag) => {
    const flagPairs: [string, string][] = [
      ['sdk-name', XCODE_27_1_DEVICE_STAMPS.sdkName],
      ['platform-version', XCODE_27_1_DEVICE_STAMPS.platformVersion],
      ['xcode', XCODE_27_1_DEVICE_STAMPS.xcode],
    ];
    const run = runCheck(flagPairs.filter(([flag]) => flag !== omittedFlag).flatMap(([flag, value]) => [`--${flag}`, value]));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`Missing --${omittedFlag}`);
  });

  it('refuses an unknown flag by name, so a typo cannot silently drop a stamp', () => {
    const run = runCheck([...stampArguments(XCODE_27_1_DEVICE_STAMPS), '--bogus', 'x']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Unknown flag --bogus');
  });

  it('honours --minimum, so build 26 passes a floor of 26', () => {
    const run = runCheck([...stampArguments(BUILD_26_STAMPS), '--minimum', '26']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('floor (26) met');
  });

  it.each(['abc', '0', '1.5'])('rejects --minimum %s, naming the flag', (minimum) => {
    const run = runCheck([...stampArguments(XCODE_27_1_DEVICE_STAMPS), '--minimum', minimum]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--minimum');
  });

  describe('GITHUB_STEP_SUMMARY', () => {
    let summaryDirectory = '';

    afterEach(() => {
      if (summaryDirectory !== '') rmSync(summaryDirectory, { recursive: true, force: true });
      summaryDirectory = '';
    });

    function runWithSummary(stamps: { sdkName: string; platformVersion: string; xcode: string }): string {
      summaryDirectory = mkdtempSync(join(tmpdir(), 'ios-sdk-summary-'));
      const summaryPath = join(summaryDirectory, 'summary.md');
      // Pre-created empty, so a missing append reads as a failed assertion.
      writeFileSync(summaryPath, '', 'utf8');
      runCheck(stampArguments(stamps), { GITHUB_STEP_SUMMARY: summaryPath });
      return readFileSync(summaryPath, 'utf8');
    }

    it('appends "met" for an Xcode 27.1 build', () => {
      expect(runWithSummary(XCODE_27_1_DEVICE_STAMPS)).toContain('**iOS SDK floor (27):** met');
    });

    it('appends "NOT met" for build 26\'s stamps', () => {
      expect(runWithSummary(BUILD_26_STAMPS)).toContain('**iOS SDK floor (27):** NOT met');
    });
  });
});

const bashExecutable = resolveBashExecutable();

/** Runs verify-ios-sdk.sh with plutil answering these Info.plist keys; an omitted key is missing. */
function runShellCheck(stamps: Partial<Record<'DTSDKName' | 'DTPlatformVersion' | 'DTXcode', string>>): ScriptRun {
  if (!bashExecutable) {
    throw new Error('resolveBashExecutable returned null; the suite should have been skipped.');
  }
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['DTSDKName', 'DTPlatformVersion', 'DTXcode'] as const) {
    delete environment[`STUB_${key}`];
    const value = stamps[key];
    if (value !== undefined) environment[`STUB_${key}`] = value;
  }
  return runCaptured(bashExecutable, [harnessPath], environment);
}

// Skipped rather than failed without a usable bash, so a Windows developer
// without Git Bash sees why. The ubuntu runner that hosts the unit tier always
// has bash, so this never skips in CI.
describe.skipIf(!bashExecutable)('verify-ios-sdk.sh', () => {
  it("fails build 26's Info.plist stamps", () => {
    const run = runShellCheck({ DTSDKName: 'iphoneos26.5', DTPlatformVersion: '26.5', DTXcode: '2660' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('ITMS-90725');
  });

  it('passes an Xcode 27.1 build, so each stamp reached its own flag', () => {
    const run = runShellCheck({ DTSDKName: 'iphoneos27.1', DTPlatformVersion: '27.1', DTXcode: '2710' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('DTSDKName iphoneos27.1, DTPlatformVersion 27.1, Xcode 27.1');
  });

  it('fails a key plutil cannot find by name, rather than on plutil\'s own error', () => {
    const run = runShellCheck({ DTPlatformVersion: '27.1', DTXcode: '2710' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('no DTSDKName');
  });
});
