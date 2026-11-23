#!/usr/bin/env node
/**
 * Fails an iOS build that was made with an SDK older than App Store Connect accepts.
 *
 * Why this exists: v1.5.1 build 25 and v1.6.0 build 26 were both built on
 * `macos-latest` with the iOS 26.5 SDK, and both uploads drew Apple's ITMS-90725:
 * from April 2027, App Store Connect refuses an upload or a submission that was not
 * built with the iOS 27 SDK or later (Xcode 27 or later). The only signal was an
 * email, after the upload. build-ios.yml now compiles on the `xcode-27` runner
 * label with the point release pinned by IOS_XCODE_VERSION. This check reads what
 * the toolchain actually stamped into the built app, so an edit that quietly goes
 * back to an older runner fails the build instead of producing another email.
 *
 * It reads three keys Xcode writes into every built app's Info.plist:
 *
 *   DTSDKName          iphoneos27.1 for a device build, iphonesimulator27.1 for a
 *                      simulator build
 *   DTPlatformVersion  27.1
 *   DTXcode            2710, which is Xcode 27.1.0 (see xcodeVersionLabel)
 *
 * The values arrive as flags rather than as a plist path. Reading a built app's
 * binary Info.plist needs `plutil`, which only macOS has, so
 * .github/scripts/verify-ios-sdk.sh does the reading and this half stays runnable,
 * and tested, anywhere.
 *
 * Usage: node scripts/checkIosSdk.mjs --sdk-name <DTSDKName>
 *          --platform-version <DTPlatformVersion> --xcode <DTXcode> [--minimum <major>]
 * Prints the verdict, adds a line to GITHUB_STEP_SUMMARY when that is set, and
 * exits 1 with `::error::` annotations when the floor is not met.
 */
import { appendFileSync } from 'node:fs';

import { parseFlagPairs } from './lib/cliArguments.mjs';
import { isEntrypoint } from './lib/is-entrypoint.mjs';

/**
 * The oldest iOS SDK major App Store Connect accepts. The ONE place the floor
 * lives: tests/unit/buildWorkflow.test.ts holds build-ios.yml's runner label and
 * IOS_XCODE_VERSION to it. Raise it when Apple raises the floor.
 */
export const MINIMUM_IOS_SDK_MAJOR = 27;

const SDK_NAME_PATTERN = /^(iphoneos|iphonesimulator)(\d+)\.(\d+)$/;
const PLATFORM_VERSION_PATTERN = /^(\d+)(?:\.\d+){0,2}$/;
// Four digits, zero padded: 0940 was Xcode 9.4, 2660 is Xcode 26.6.
const XCODE_STAMP_PATTERN = /^\d{4}$/;

/**
 * DTXcode packs the version as major * 100 + minor * 10 + patch, so 2710 is
 * Xcode 27.1 and 2711 is Xcode 27.1.1.
 *
 * @param {number} stamp
 * @returns {string}
 */
function xcodeVersionLabel(stamp) {
  const major = Math.floor(stamp / 100);
  const minor = Math.floor((stamp % 100) / 10);
  const patch = stamp % 10;
  return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

/**
 * @param {{ sdkName?: string, platformVersion?: string, xcode?: string }} stamps
 *   the DTSDKName, DTPlatformVersion and DTXcode values; a missing key is empty
 * @param {number} [minimumMajor]
 * @returns {{ passed: boolean, problems: string[], summary: string }}
 */
export function evaluateIosSdk(stamps, minimumMajor = MINIMUM_IOS_SDK_MAJOR) {
  const sdkName = (stamps.sdkName ?? '').trim();
  const platformVersion = (stamps.platformVersion ?? '').trim();
  const xcode = (stamps.xcode ?? '').trim();
  /** @type {string[]} */
  const problems = [];

  // A missing or unreadable stamp is a failure, not a pass: the point of the
  // check is to PROVE the SDK, and "could not read it" proves nothing.
  const sdkMatch = SDK_NAME_PATTERN.exec(sdkName);
  /** @type {number | null} */
  let sdkMajor = null;
  if (sdkMatch === null) {
    problems.push(
      sdkName === ''
        ? 'The app has no DTSDKName, so the SDK it was built with cannot be proven.'
        : `DTSDKName "${sdkName}" is not an iphoneos or iphonesimulator SDK name.`
    );
  } else {
    sdkMajor = Number(sdkMatch[2]);
    if (sdkMajor < minimumMajor) {
      problems.push(
        `The app was built with the iOS ${sdkMatch[2]}.${sdkMatch[3]} SDK. App Store Connect requires the iOS ${minimumMajor} SDK or later (ITMS-90725), and from April 2027 refuses the upload.`
      );
    }
  }

  const platformMatch = PLATFORM_VERSION_PATTERN.exec(platformVersion);
  if (platformMatch === null) {
    problems.push(
      platformVersion === ''
        ? 'The app has no DTPlatformVersion.'
        : `DTPlatformVersion "${platformVersion}" is not a version number.`
    );
  } else if (sdkMajor !== null && Number(platformMatch[1]) !== sdkMajor) {
    problems.push(`DTPlatformVersion ${platformVersion} disagrees with DTSDKName ${sdkName}.`);
  }

  // Apple's rule names the Xcode as well as the SDK ("included in Xcode 27 or
  // later"), so the Xcode stamp is held to the same floor.
  let xcodeLabel = xcode;
  if (!XCODE_STAMP_PATTERN.test(xcode)) {
    problems.push(
      xcode === '' ? 'The app has no DTXcode.' : `DTXcode "${xcode}" is not an Xcode version stamp.`
    );
  } else {
    const stamp = Number(xcode);
    xcodeLabel = xcodeVersionLabel(stamp);
    if (Math.floor(stamp / 100) < minimumMajor) {
      problems.push(
        `The app was built with Xcode ${xcodeLabel}. App Store Connect requires Xcode ${minimumMajor} or later (ITMS-90725).`
      );
    }
  }

  const summary = `DTSDKName ${sdkName || '(missing)'}, DTPlatformVersion ${platformVersion || '(missing)'}, Xcode ${xcodeLabel || '(missing)'}`;
  return { passed: problems.length === 0, problems, summary };
}

const USAGE =
  'usage: checkIosSdk.mjs --sdk-name <DTSDKName> --platform-version <DTPlatformVersion> --xcode <DTXcode> [--minimum <major>]';
const KNOWN_FLAGS = new Set(['sdk-name', 'platform-version', 'xcode', 'minimum']);

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {number} the exit code
 */
function main(argv) {
  const flags = parseFlagPairs(argv);
  for (const flag of Object.keys(flags)) {
    if (!KNOWN_FLAGS.has(flag)) throw new Error(`Unknown flag --${flag}. ${USAGE}`);
  }
  // Required to be PRESENT, but each may be empty: verify-ios-sdk.sh passes an
  // empty value for a key the plist lacks, and evaluateIosSdk names it.
  for (const flag of ['sdk-name', 'platform-version', 'xcode']) {
    if (!(flag in flags)) throw new Error(`Missing --${flag}. ${USAGE}`);
  }
  const minimumMajor = flags.minimum === undefined ? MINIMUM_IOS_SDK_MAJOR : Number(flags.minimum);
  if (!Number.isInteger(minimumMajor) || minimumMajor < 1) {
    throw new Error(`--minimum must be a positive whole number, got "${flags.minimum}".`);
  }

  const verdict = evaluateIosSdk(
    { sdkName: flags['sdk-name'], platformVersion: flags['platform-version'], xcode: flags.xcode },
    minimumMajor
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n**iOS SDK floor (${minimumMajor}):** ${verdict.passed ? 'met' : 'NOT met'}. ${verdict.summary}.\n`
    );
  }

  if (verdict.passed) {
    process.stdout.write(`iOS SDK floor (${minimumMajor}) met: ${verdict.summary}.\n`);
    return 0;
  }
  for (const problem of verdict.problems) {
    process.stdout.write(`::error::${problem}\n`);
  }
  process.stdout.write(
    `::error::Read: ${verdict.summary}. build-ios.yml compiles on the xcode-<major> runner label with the point release pinned by IOS_XCODE_VERSION; move the label and the pin together. See "The SDK comes with the runner image" in docs/developer-guide.md.\n`
  );
  return 1;
}

if (isEntrypoint(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
