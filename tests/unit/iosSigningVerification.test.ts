/**
 * Guards the signing-verification step in `.github/workflows/build-ios.yml`
 * against the flag mistake that broke the v0.6.3 iOS release.
 *
 * The step verified the Notification Service Extension's provisioning profile
 * with:
 *
 *   xcodebuild -showBuildSettings -workspace ios/X.xcworkspace \
 *     -scheme X -target KangenticNSE -configuration Release > out 2>/dev/null || true
 *
 * `-target` selects a target inside a `-project`; it is not valid alongside
 * `-workspace`, where `-scheme` is the selector. So the invocation could not
 * observe the extension target at all - and because its stderr went to
 * /dev/null under `|| true`, the settings file came back EMPTY rather than the
 * command failing. The grep that followed then found nothing and reported "the
 * extension is not set to its provisioning profile", naming a plugin ordering
 * that was correct all along. Every signed build would have failed the same way.
 *
 * It shipped green because nothing ran it: between the extension landing and
 * the release, every `build-ios.yml` dispatch used `target=simulator`, which
 * skips the Device job entirely. The first `target=device` build in that window
 * was the release itself.
 *
 * These are source assertions rather than an execution test on purpose:
 * `xcodebuild` exists only on a macOS runner, so the unit tier cannot run the
 * command. What it CAN do is refuse the flag combination that cannot work, and
 * refuse the stderr suppression that turned a broken probe into a false
 * accusation.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflowPath = fileURLToPath(new URL('../../.github/workflows/build-ios.yml', import.meta.url));
const workflowSource = readFileSync(workflowPath, 'utf8');

/**
 * The workflow's shell commands with YAML/shell comments removed and backslash
 * continuations joined, so each `xcodebuild` call is one string.
 *
 * Stripping comments is load bearing, not tidiness: the fixed step documents the
 * bug by quoting the exact bad command, so a scan over raw source would flag the
 * very comment that explains why the command is banned.
 */
function executableCommands(): string[] {
  const withoutComments = workflowSource
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  // Join `\`-continued lines into a single logical command.
  const joined = withoutComments.replaceAll(/\\\s*\n\s*/g, ' ');
  return joined.split('\n');
}

function xcodebuildInvocations(): string[] {
  return executableCommands().filter((line) => line.includes('xcodebuild '));
}

describe('build-ios.yml xcodebuild invocations', () => {
  it('runs at least one xcodebuild command, so the scan below is not vacuous', () => {
    expect(xcodebuildInvocations().length).toBeGreaterThan(0);
  });

  /**
   * The regression itself. `-target` belongs with `-project`; combined with
   * `-workspace` it cannot select the target, so any check reading the result is
   * asserting against the wrong settings or against nothing at all.
   */
  it('never combines -workspace with -target', () => {
    const offenders = xcodebuildInvocations().filter(
      (command) => command.includes('-workspace') && /\s-target\s/.test(command),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the Notification Service Extension signing check', () => {
  /**
   * The check must read the generated project directly. That is the evidence it
   * actually wants (did withIosManualSigning write the setting), and unlike an
   * xcodebuild probe it cannot fail for scheme, workspace or flag reasons.
   */
  it('verifies the extension profile by grepping the generated pbxproj', () => {
    expect(workflowSource).toContain('project.pbxproj');
    expect(workflowSource).toMatch(/PROVISIONING_PROFILE_SPECIFIER = .*KANGENTIC_IOS_NSE_PROFILE_UUID/);
  });

  /**
   * The masking half of the bug, which is what made it misleading rather than
   * merely wrong: with stderr discarded and `|| true`, a probe that never ran
   * was indistinguishable from a probe that ran and found a misconfiguration.
   */
  it('does not discard stderr while probing the extension, so a broken probe cannot pass as a config error', () => {
    const nseCheckSource = workflowSource.slice(workflowSource.indexOf('KANGENTIC_IOS_NSE_PROFILE_UUID:-'));
    const nseCheckBody = nseCheckSource.slice(0, nseCheckSource.indexOf('Extension target is on manual signing'));
    expect(nseCheckBody).not.toContain('2>/dev/null');
  });
});
