/**
 * Executes .github/scripts/upload-ios-testflight.sh against a stubbed `xcrun` and
 * asserts its exit code, so what is under test is the script's actual decision
 * rather than whether a string appears in its source.
 *
 * That distinction is the whole reason this file exists. The first version of the
 * script treated `The bundle version must be higher` as success, alongside
 * "already exists" and "redundant". Those two mean *our* binary is already on App
 * Store Connect, which on a retry is the goal state. That one means Apple
 * **rejected** this binary because something else occupies the version, and
 * exiting 0 on it would have reported a failed upload as a completed release. A
 * source grep would not have caught it: the string was present, in the right
 * file, next to plausible neighbours.
 *
 * Bash is available on the ubuntu runner that hosts the unit tier, and locally
 * through Git Bash on Windows.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Forward slashes on purpose. A backslash path handed to bash as an argument has
// its separators eaten, which surfaces as a confusing "No such file or directory"
// for a file that plainly exists.
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url)).replaceAll('\\', '/');
const harnessPath = `${repositoryRoot}tests/unit/fixtures/runUploadWithStubbedAltool.sh`;

/**
 * On Windows, `bash` on PATH is usually WSL's, which cannot open a `C:/...` path
 * at all and fails with a "No such file or directory" that looks like a missing
 * file rather than a wrong interpreter. Git Bash can, and is what the rest of the
 * repository's tooling uses. Paths are derived from the environment rather than
 * hardcoded (.claude/rules/no-personal-info.md).
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

interface UploadOutcome {
  exitCode: number;
  output: string;
}

/**
 * @param altoolOutput what the stubbed altool prints
 * @param altoolExitCode 0 for a successful upload, non-zero for a rejection
 * @param runAttempt the GitHub Actions run attempt; >1 means this job was re-run
 */
function runHarness(harnessArguments: string[], environment: Record<string, string>): UploadOutcome {
  if (!bashExecutable) {
    throw new Error('resolveBashExecutable returned null; the suite should have been skipped.');
  }
  try {
    const output = execFileSync(bashExecutable, [harnessPath, ...harnessArguments], {
      encoding: 'utf8',
      env: { ...process.env, ...environment },
    });
    return { exitCode: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

function runUpload(altoolOutput: string, altoolExitCode: number, runAttempt = 1): UploadOutcome {
  return runHarness([altoolOutput, String(altoolExitCode)], {
    GITHUB_RUN_ATTEMPT: String(runAttempt),
  });
}

const REJECTED_FOR_DUPLICATE_VERSION =
  'ERROR ITMS-4190: The bundle version must be higher than the previously uploaded version';
const ALREADY_PRESENT = 'ERROR ITMS-4238: Redundant Binary Upload. A binary already exists for this build';
const AUTHENTICATION_FAILED = 'Error: Unable to authenticate with App Store Connect';
const APPLE_SERVER_ERROR = 'Error: An unexpected error occurred on the server side. Try again later';

// Skipped rather than failed when no usable bash exists, so a Windows developer
// without Git Bash sees the reason instead of a mystery. The ubuntu runner that
// hosts the unit tier always runs it, so this is never skipped in CI.
describe.skipIf(!bashExecutable)('upload-ios-testflight.sh', () => {
  it('succeeds when altool succeeds', () => {
    const result = runUpload('UPLOAD SUCCEEDED with no errors.', 0);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('appears in TestFlight');
  });

  it('FAILS when Apple rejects the build number', () => {
    // The regression this file was written for. Apple rejected the binary; there
    // is no sense in which this is a release.
    const result = runUpload(REJECTED_FOR_DUPLICATE_VERSION, 1);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('Bump ios.buildNumber');
  });

  it('FAILS on a rejected build number even on a re-run', () => {
    // The case that actually pins the regression. Reintroducing the bug (adding
    // "The bundle version must be higher" to the lenient duplicate branch) leaves
    // the first-attempt test above still passing, because that path exits
    // non-zero anyway and prints a message containing the same phrase. Only the
    // re-run path distinguishes them: a lenient branch would exit 0 here and
    // report Apple's rejection as a completed release.
    //
    // Verified by mutation: with the bug present this assertion fails and the
    // others do not.
    const result = runUpload(REJECTED_FOR_DUPLICATE_VERSION, 1, 2);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('Apple rejected this binary');
  });

  it('fails on a first-attempt duplicate, because that binary is not ours', () => {
    // "already exists" on attempt 1 means something else took the build number,
    // so this upload did not land.
    const result = runUpload(ALREADY_PRESENT, 1, 1);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('rejected rather than accepted');
  });

  it('succeeds on a re-run duplicate, because a previous attempt landed it', () => {
    // Re-running the submit job uploads a byte-identical artifact, so a duplicate
    // means the earlier attempt worked. This is what makes an Apple-outage retry
    // safe to run blind.
    const result = runUpload(ALREADY_PRESENT, 1, 2);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('redundant');
  });

  it('does not retry an authentication failure', () => {
    // Deterministic, so retrying only buries the cause further up the log.
    const result = runUpload(AUTHENTICATION_FAILED, 1);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('Authentication failed');
    expect(result.output).toContain('Upload attempt 1 of 3');
    expect(result.output).not.toContain('Upload attempt 2 of 3');
  });

  it('retries a server-side error, then fails', () => {
    // The case this script exists for: Apple's delivery endpoints failing
    // intermittently. Three attempts, then an honest failure that points at the
    // stored artifact.
    const result = runUpload(APPLE_SERVER_ERROR, 1);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('Upload attempt 3 of 3');
    expect(result.output).toContain('needs no rebuild');
  });

  it('refuses to run with no credentials at all', () => {
    // Guards against a dispatch that would otherwise fail deep inside altool with
    // a much less obvious message.
    const result = runHarness(['unused', '0'], { KANGENTIC_TEST_WITHOUT_CREDENTIALS: '1' });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('No App Store Connect credentials');
  });
});
