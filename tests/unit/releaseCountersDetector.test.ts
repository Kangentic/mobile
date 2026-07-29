/**
 * Pins the fail-closed guard in `.github/workflows/ci.yml`'s `release-counters`
 * job (`Detect which counters this PR changes` step), a REQUIRED status check
 * on `main` (`Release counters (store preflight)`).
 *
 * The regression this file exists for: `extract_version_code` and
 * `extract_build_number` are both called with `|| true`, needed because `grep`
 * exits 1 on no match under `set -euo pipefail`. If either regex stops
 * matching `app.config.ts` (a reformat, a counter moved into a nested or
 * computed expression, `buildNumber` requoted with double quotes), BOTH base
 * and head extract to the empty string, empty equals empty, no counter looks
 * changed, and this required check reports GREEN having preflighted nothing.
 * The next release then fails at the store. The fix is a
 * `[ -z "$head_version_code" ] || [ -z "$head_build_number" ]` guard that
 * fails closed instead. This file proves that guard actually fires, by
 * executing the real script rather than asserting against a hand-copied one.
 *
 * Modeled closely on `tests/unit/e2eGate.test.ts`: parse the workflow with
 * `yaml`, locate the step BY NAME (never by position), throw loudly if the
 * extraction fails, and EXECUTE the real extracted shell.
 *
 * APPROACH (a), not (b), on how to execute the step without a real git
 * history: the step's very first act is
 * `git show "$BASE_SHA:app.config.ts" > file`, which needs a real commit at
 * BASE_SHA in a real repository to do anything meaningful. Stubbing `git` on
 * PATH (approach (b)) means shipping an executable shim and getting it to win
 * the PATH race ahead of the real `git`, which behaves differently on a
 * Windows Git Bash shell than on the Linux runner CI actually uses to run
 * this same step, exactly the fragility this task warns about. Instead, this
 * file removes ONLY that one `git show` line (throwing if it cannot find it,
 * so the removal itself cannot silently stop applying) and pre-writes the
 * file it would have produced. Everything else, both `extract_*` functions,
 * the fail-closed guard, and the android/ios detection, executes as the real,
 * unmodified text read out of ci.yml at runtime. No hand-copied shell lives
 * in this file.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url)).replaceAll('\\', '/');
const workflowPath = `${repositoryRoot}.github/workflows/ci.yml`;
const realAppConfigPath = `${repositoryRoot}app.config.ts`;

interface DetectorStep {
  name?: string;
  run?: string;
}
interface ReleaseCountersJob {
  name?: string;
  steps?: DetectorStep[];
}
interface CiWorkflow {
  jobs?: Record<string, ReleaseCountersJob>;
}

const RELEASE_COUNTERS_JOB_NAME = 'release-counters';
const DETECTOR_STEP_NAME = 'Detect which counters this PR changes';

/**
 * Pulled out of the workflow rather than kept as a copy in `tests/`, so the
 * thing under test is always the script CI actually runs. A duplicated copy
 * would keep passing after the workflow drifted away from it, which is the
 * failure mode this whole file is guarding against.
 */
function readDetectorScript(): string {
  const workflow = parseYaml(readFileSync(workflowPath, 'utf8')) as CiWorkflow;
  const releaseCountersJob = workflow.jobs?.[RELEASE_COUNTERS_JOB_NAME];
  if (!releaseCountersJob) {
    throw new Error(
      `ci.yml has no \`${RELEASE_COUNTERS_JOB_NAME}\` job. If the job was renamed, update this test AND main's branch protection.`,
    );
  }
  // Selected BY NAME, not as "the first run step in the job". Positional
  // selection works right up until someone adds a setup step above it, at
  // which point this file would quietly start executing that instead and
  // pass while testing nothing. Throwing beats guessing.
  const detectorStep = releaseCountersJob.steps?.find((step) => step.name === DETECTOR_STEP_NAME);
  if (!detectorStep) {
    const foundStepNames = (releaseCountersJob.steps ?? []).map((step) => step.name ?? '(unnamed)').join(', ');
    throw new Error(
      `The \`${RELEASE_COUNTERS_JOB_NAME}\` job has no step named "${DETECTOR_STEP_NAME}". Found: ${foundStepNames}. ` +
        'Rename this constant to match, do NOT fall back to picking a step by position.',
    );
  }
  if (typeof detectorStep.run !== 'string') {
    throw new Error(`Step "${DETECTOR_STEP_NAME}" has no \`run:\` script to execute.`);
  }
  return detectorStep.run;
}

const GIT_SHOW_LINE = 'git show "$BASE_SHA:app.config.ts" > "$RUNNER_TEMP/base-app.config.ts"';

/**
 * See the file header for why this is the one line replaced rather than the
 * whole step being run against a stubbed `git`. Throws rather than silently
 * no-opping if the line has moved or changed, so a future edit to the step
 * cannot make this file quietly stop exercising the real fetch path's
 * downstream logic.
 */
function scriptWithoutGitShow(script: string): string {
  if (!script.includes(GIT_SHOW_LINE)) {
    throw new Error(
      'Could not find the `git show ... > base-app.config.ts` line in the detector step. ' +
        "If the step changed how it fetches the base config, update this test's fixture wiring (and this constant) to match.",
    );
  }
  return script.replace(
    GIT_SHOW_LINE,
    '# git show replaced by the test harness: base-app.config.ts is pre-written to $RUNNER_TEMP instead of being fetched from git.',
  );
}

/**
 * On Windows, `bash` on PATH is usually WSL's, which cannot open a `C:/...`
 * path and fails with a "No such file or directory" that reads like a missing
 * file rather than a wrong interpreter. Git Bash can. Paths come from the
 * environment rather than being hardcoded (.claude/rules/no-personal-info.md).
 */
function resolveBashExecutable(): string | null {
  if (process.platform !== 'win32') {
    return 'bash';
  }
  const candidates = [
    process.env.KANGENTIC_BASH,
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const bashExecutable = resolveBashExecutable();

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const directory = temporaryRoots.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function createTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), `release-counters-${prefix}-`));
  temporaryRoots.push(directory);
  return directory;
}

interface DetectorOutcome {
  exitCode: number;
  /** stdout and stderr combined, since the `::error::` line is a plain echo on stdout. */
  output: string;
  /** `steps.changed.outputs.android`, or null if the guard exited before writing it. */
  androidChanged: string | null;
  /** `steps.changed.outputs.ios`, or null if the guard exited before writing it. */
  iosChanged: string | null;
}

/**
 * Runs the REAL "Detect which counters this PR changes" step (minus the one
 * `git show` line, see the file header) against fixture base/head
 * `app.config.ts` contents, exactly as the job does it: HEAD read from the
 * working directory, BASE read from `$RUNNER_TEMP/base-app.config.ts`,
 * `android`/`ios` written to `$GITHUB_OUTPUT`.
 */
function runDetector(baseAppConfigContents: string, headAppConfigContents: string): DetectorOutcome {
  if (!bashExecutable) {
    throw new Error('resolveBashExecutable returned null; the suite should have been skipped.');
  }
  const workingDirectory = createTemporaryDirectory('head');
  const runnerTempDirectory = createTemporaryDirectory('runner-temp');
  const githubOutputPath = join(runnerTempDirectory, 'github-output.txt');

  writeFileSync(join(workingDirectory, 'app.config.ts'), headAppConfigContents, 'utf8');
  writeFileSync(join(runnerTempDirectory, 'base-app.config.ts'), baseAppConfigContents, 'utf8');
  writeFileSync(githubOutputPath, '', 'utf8');

  const script = scriptWithoutGitShow(readDetectorScript());
  const result = spawnSync(bashExecutable, ['-c', script], {
    cwd: workingDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Forward slashes: MSYS bash resolves a `C:/...`-shaped path natively,
      // the same conversion e2eGate.test.ts applies to repositoryRoot.
      RUNNER_TEMP: runnerTempDirectory.replaceAll('\\', '/'),
      GITHUB_OUTPUT: githubOutputPath.replaceAll('\\', '/'),
      // The real value is a commit SHA; unused here because scriptWithoutGitShow
      // already removed the only line that would have read it.
      BASE_SHA: 'unused-the-test-harness-removed-the-git-show-call',
    },
  });

  const outputContents = readFileSync(githubOutputPath, 'utf8');
  return {
    exitCode: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    androidChanged: /^android=(.*)$/m.exec(outputContents)?.[1] ?? null,
    iosChanged: /^ios=(.*)$/m.exec(outputContents)?.[1] ?? null,
  };
}

function readExtractorFunctionDefinitions(script: string): string {
  const versionCodeFunction = script.match(/extract_version_code\(\) \{[^\n]*\}/);
  const buildNumberFunction = script.match(/extract_build_number\(\) \{[^\n]*\}/);
  if (!versionCodeFunction || !buildNumberFunction) {
    throw new Error('Could not find the extract_version_code/extract_build_number function definitions in the detector step.');
  }
  return `${versionCodeFunction[0]}\n${buildNumberFunction[0]}`;
}

/**
 * Runs just one `extract_*` function, verbatim out of the workflow, against
 * fixture stdin content. Used for the canary (case 1) and the anchoring case
 * (case 5), where the guard and the android/ios comparison are not in play,
 * so exercising the bare regex is the non-vacuous, non-hand-copied check.
 */
function extractField(fieldExtractorFunctionName: 'extract_version_code' | 'extract_build_number', appConfigContents: string): string {
  if (!bashExecutable) {
    throw new Error('resolveBashExecutable returned null; the suite should have been skipped.');
  }
  const script = `${readExtractorFunctionDefinitions(readDetectorScript())}\n${fieldExtractorFunctionName}`;
  const result = spawnSync(bashExecutable, ['-c', script], {
    input: appConfigContents,
    encoding: 'utf8',
  });
  return (result.stdout ?? '').trim();
}

/** A minimal, realistically-shaped app.config.ts with the two counter lines swappable. */
function appConfigFixture(versionCodeLine: string, buildNumberLine: string): string {
  return [
    "import type { ExpoConfig } from 'expo/config';",
    '',
    "// versionCode and buildNumber are the store release counters; see docs/developer-guide.md.",
    'const config: ExpoConfig = {',
    "  name: 'Kangentic',",
    "  version: '1.2.0',",
    '  android: {',
    `    ${versionCodeLine}`,
    '  },',
    '  ios: {',
    `    ${buildNumberLine}`,
    '  },',
    '};',
    '',
    'export default config;',
    '',
  ].join('\n');
}

const VALID_VERSION_CODE_LINE = 'versionCode: 42,';
const VALID_BUILD_NUMBER_LINE = "buildNumber: '17',";

describe.skipIf(!bashExecutable)('the Release counters (store preflight) detector', () => {
  describe('against the real app.config.ts (canary)', () => {
    // The whole point of this case: it fails the day someone reformats the
    // real file in a way the regexes miss, which is the exact incident this
    // job exists to prevent from reaching a release PR undetected.
    it('extracts a non-empty versionCode and buildNumber', () => {
      const realAppConfigContents = readFileSync(realAppConfigPath, 'utf8');

      const versionCode = extractField('extract_version_code', realAppConfigContents);
      const buildNumber = extractField('extract_build_number', realAppConfigContents);

      expect(versionCode).not.toBe('');
      expect(versionCode).toMatch(/^[0-9]+$/);
      expect(buildNumber).not.toBe('');
      expect(buildNumber).toMatch(/^[0-9]+$/);
    });
  });

  describe('fails CLOSED when the head config is unreadable', () => {
    const validBase = appConfigFixture(VALID_VERSION_CODE_LINE, VALID_BUILD_NUMBER_LINE);

    const unreadableHeadConfigs: [string, string][] = [
      ['versionCode moved into a computed expression', appConfigFixture('versionCode: computeVersionCode(),', VALID_BUILD_NUMBER_LINE)],
      ['versionCode commented out', appConfigFixture('// versionCode: 42,', VALID_BUILD_NUMBER_LINE)],
      // The exact fail-open example named in the bug report: requoted with
      // double quotes instead of single.
      ['buildNumber requoted with double quotes', appConfigFixture(VALID_VERSION_CODE_LINE, 'buildNumber: "17",')],
      ['buildNumber commented out', appConfigFixture(VALID_VERSION_CODE_LINE, "// buildNumber: '17',")],
    ];

    for (const [label, headConfig] of unreadableHeadConfigs) {
      it(`exits non-zero when ${label}`, () => {
        const result = runDetector(validBase, headConfig);

        expect(result.exitCode).not.toBe(0);
        expect(result.output).toContain('::error::');
        expect(result.output).toContain('Could not read versionCode and/or buildNumber');
        // The guard must exit before writing android/ios, or a downstream
        // step reading `steps.changed.outputs.android` would see stale data
        // rather than nothing.
        expect(result.androidChanged).toBeNull();
        expect(result.iosChanged).toBeNull();
      });
    }

    // This is the actual incident shape, not just "head is broken while base
    // is fine". A reformat that breaks a regex breaks it identically on BOTH
    // files, since base and head are the same app.config.ts shape most of the
    // time. Without the guard that is base="" head="", empty equals empty,
    // `android=false ios=false`, exit 0: green having preflighted nothing.
    // The four cases above alone would not catch that, because a valid base
    // against a broken head still differs ("42" != ""), which trips the
    // android/ios comparison into reporting a (spurious) change even with the
    // guard removed. Only a same-shape base and head reproduces the silent
    // green.
    it('exits non-zero when a reformat breaks the regexes on BOTH sides identically', () => {
      const bothSidesBroken = appConfigFixture('versionCode: computeVersionCode(),', 'buildNumber: "17",');

      const result = runDetector(bothSidesBroken, bothSidesBroken);

      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('::error::');
      expect(result.androidChanged).toBeNull();
      expect(result.iosChanged).toBeNull();
    });
  });

  describe('does NOT fail closed when only the base is unreadable', () => {
    // The step's own comment: "Only HEAD is guarded. An empty BASE is
    // legitimate: it is what a brand-new counter field looks like on the base
    // commit." A future edit that widens the guard to also check
    // `base_version_code`/`base_build_number` would redden every PR that
    // introduces a counter field for the first time, which this case pins
    // against.
    it('still detects the change when a brand-new field has no value on the base commit', () => {
      const base = appConfigFixture(VALID_VERSION_CODE_LINE, '// buildNumber lands in this PR, not yet on base');
      const head = appConfigFixture(VALID_VERSION_CODE_LINE, VALID_BUILD_NUMBER_LINE);

      const result = runDetector(base, head);

      expect(result.exitCode).toBe(0);
      expect(result.androidChanged).toBe('false');
      expect(result.iosChanged).toBe('true');
    });
  });

  describe('detects no counter change when base and head match', () => {
    it('exits 0 with both android and ios false', () => {
      const config = appConfigFixture(VALID_VERSION_CODE_LINE, VALID_BUILD_NUMBER_LINE);

      const result = runDetector(config, config);

      expect(result.exitCode).toBe(0);
      expect(result.androidChanged).toBe('false');
      expect(result.iosChanged).toBe('false');
    });
  });

  describe('detects which counter changed', () => {
    it('flags android when versionCode changed and buildNumber did not', () => {
      const base = appConfigFixture(VALID_VERSION_CODE_LINE, VALID_BUILD_NUMBER_LINE);
      const head = appConfigFixture('versionCode: 43,', VALID_BUILD_NUMBER_LINE);

      const result = runDetector(base, head);

      expect(result.exitCode).toBe(0);
      expect(result.androidChanged).toBe('true');
      expect(result.iosChanged).toBe('false');
    });

    it('flags ios when buildNumber changed and versionCode did not', () => {
      const base = appConfigFixture(VALID_VERSION_CODE_LINE, VALID_BUILD_NUMBER_LINE);
      const head = appConfigFixture(VALID_VERSION_CODE_LINE, "buildNumber: '18',");

      const result = runDetector(base, head);

      expect(result.exitCode).toBe(0);
      expect(result.androidChanged).toBe('false');
      expect(result.iosChanged).toBe('true');
    });
  });

  describe('anchoring: a comment naming the field must not be extracted', () => {
    // The step's own comment says the anchor exists so the many comments
    // mentioning versionCode/buildNumber by name cannot match. This proves it
    // directly against the bare function, independent of the guard: content
    // whose ONLY mention of the field is a `//` comment must extract to
    // empty, not to the number sitting inside the comment.
    it('does not extract a versionCode sitting in a comment', () => {
      const commentOnlyConfig = ['const config = {', '  // versionCode: 99', '};', ''].join('\n');

      expect(extractField('extract_version_code', commentOnlyConfig)).toBe('');
    });

    it('does not extract a buildNumber sitting in a comment', () => {
      const commentOnlyConfig = ['const config = {', "  // buildNumber: '99'", '};', ''].join('\n');

      expect(extractField('extract_build_number', commentOnlyConfig)).toBe('');
    });

    it('still finds the real field when a decoy comment is present elsewhere in the file', () => {
      const withDecoyComment = appConfigFixture(VALID_VERSION_CODE_LINE, VALID_BUILD_NUMBER_LINE).replace(
        "const config: ExpoConfig = {",
        ['// Bumping soon: versionCode: 99 and buildNumber: \'99\' are NOT the values below.', 'const config: ExpoConfig = {'].join('\n'),
      );

      expect(extractField('extract_version_code', withDecoyComment)).toBe('42');
      expect(extractField('extract_build_number', withDecoyComment)).toBe('17');
    });
  });

  it('reads the detector script out of the workflow, not a copy', () => {
    // Non-vacuity guard. If the extraction silently stops finding the script,
    // every assertion above would be running against something else.
    const script = readDetectorScript();
    expect(script).toContain('extract_version_code');
    expect(script).toContain('extract_build_number');
    expect(script).toContain('GITHUB_OUTPUT');
    expect(script).toContain('::error::');
  });
});
