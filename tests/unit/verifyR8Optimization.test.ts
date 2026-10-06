/**
 * Executes `.github/scripts/verify-r8-optimization.sh` against real-shaped R8
 * configuration files.
 *
 * The guard is the only check that proves optimization is ON in a built
 * artifact rather than merely requested in build.gradle, and its value rests
 * on properties a source-text assertion cannot reach: it must PASS on a
 * correct merged configuration (which carries a commented-out `-dontoptimize`
 * from a library), and FAIL on the legacy preset or on any live
 * `-dontoptimize`. So this runs the thing, as verifyAndroidAssets.test.ts does.
 *
 * The fixtures mirror the layout AGP writes - one section per input file,
 * each under a "The proguard configuration file for the following section is"
 * header - with generic runner paths, never a developer's machine path.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const guardScript = `${repositoryRoot}.github/scripts/verify-r8-optimization.sh`;

const CHECKOUT = '/home/runner/work/mobile/mobile';
const HEADER = '# The proguard configuration file for the following section is';

function section(path: string, lines: string[]): string {
  return [`${HEADER} ${path}`, ...lines, `# End of content from ${path}`].join('\n');
}

const aaptRules = section(`${CHECKOUT}/android/app/build/intermediates/aapt_proguard_file/release/processReleaseResources/aapt_rules.txt`, [
  '-keep class com.kangentic.mobile.MainActivity { <init>(); }',
]);

const optimizePreset = section(
  `${CHECKOUT}/android/app/build/intermediates/default_proguard_files/global/proguard-android-optimize.txt-8.12.0`,
  ['-allowaccessmodification', '-keepattributes AnnotationDefault,Signature'],
);

const legacyPreset = section(
  `${CHECKOUT}/android/app/build/intermediates/default_proguard_files/global/proguard-android.txt-8.12.0`,
  ['-dontoptimize', '-keepattributes AnnotationDefault,Signature'],
);

const appRules = section(`${CHECKOUT}/android/app/proguard-rules.pro`, [
  '-keepattributes SourceFile,LineNumberTable',
  '-keep class * implements expo.modules.apploader.HeadlessAppLoader { *; }',
]);

// A real merged configuration carries exactly this: a library's rules file
// with the option commented out. It must not count.
const libraryWithCommentedOption = section(
  `${CHECKOUT}/node_modules/some-library/android/build/intermediates/consumer_proguard_dir/release/exportReleaseConsumerProguardFiles/lib0/proguard.txt`,
  ['# -dontobfuscate', '#   -dontoptimize', '-keep class com.example.library.** { *; }'],
);

const libraryWithLiveOption = section(
  `${CHECKOUT}/node_modules/offending-library/android/build/intermediates/consumer_proguard_dir/release/exportReleaseConsumerProguardFiles/lib0/proguard.txt`,
  ['  -dontoptimize', '-keep class com.example.offender.** { *; }'],
);

const scratch = mkdtempSync(join(tmpdir(), 'verify-r8-optimization-'));

function configurationFile(sections: string[], fixtureName: string): string {
  const path = join(scratch, fixtureName);
  writeFileSync(path, `${sections.join('\n')}\n`);
  return path;
}

interface GuardResult {
  status: number;
  output: string;
}

/** Exit code and combined output of the guard against one configuration file. */
function runGuard(configurationPath: string): GuardResult {
  try {
    const output = execFileSync('bash', [guardScript, configurationPath], { encoding: 'utf8' });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { status: failure.status ?? -1, output: failure.stdout ?? '' };
  }
}

/** Same headroom, and the same reason, as verifyAndroidAssets.test.ts. */
const BASH_SPAWN_TIMEOUT_MS = 30_000;

describe('verify-r8-optimization.sh', () => {
  it('passes for the optimize preset with no live -dontoptimize anywhere', () => {
    const path = configurationFile([aaptRules, optimizePreset, appRules, libraryWithCommentedOption], 'optimized.txt');
    expect(runGuard(path).status).toBe(0);
  }, BASH_SPAWN_TIMEOUT_MS);

  it('fails on the legacy -dontoptimize preset, which is what 0.8.1 shipped', () => {
    const path = configurationFile([aaptRules, legacyPreset, appRules], 'legacy.txt');
    const result = runGuard(path);
    expect(result.status).toBe(1);
    expect(result.output).toContain('proguard-android-optimize.txt');
  }, BASH_SPAWN_TIMEOUT_MS);

  it('fails when a library turns optimization off despite the optimize preset, and names it', () => {
    // The case the preset swap alone cannot prevent: ProGuard options are
    // global, so this one line disables optimization for the whole app.
    const path = configurationFile([aaptRules, optimizePreset, appRules, libraryWithLiveOption], 'library-off.txt');
    const result = runGuard(path);
    expect(result.status).toBe(1);
    expect(result.output).toContain('offending-library');
  }, BASH_SPAWN_TIMEOUT_MS);

  it('does not count a commented-out -dontoptimize', () => {
    const path = configurationFile([optimizePreset, libraryWithCommentedOption], 'commented.txt');
    expect(runGuard(path).status).toBe(0);
  }, BASH_SPAWN_TIMEOUT_MS);

  it('fails rather than passing vacuously when the configuration is missing', () => {
    expect(runGuard(join(scratch, 'does-not-exist.txt')).status).toBe(1);
  }, BASH_SPAWN_TIMEOUT_MS);

  it('does not decide anything by piping into grep', () => {
    // verify-android-signature.sh records `| grep -q` failing a correct AAB
    // twice (SIGPIPE under pipefail reports 141 on a real match).
    const code = readFileSync(guardScript, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/\|\s*grep\s+-[a-zA-Z]*q/);
  }, BASH_SPAWN_TIMEOUT_MS);
});
