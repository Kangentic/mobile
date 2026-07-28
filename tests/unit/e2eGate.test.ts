/**
 * Extracts the `E2E Tests (Maestro)` gate script out of `.github/workflows/e2e.yml`
 * and EXECUTES it against the job states the workflow can hand it, asserting the
 * exit code rather than grepping the source. Same approach, and same reasoning,
 * as `iosTestflightUpload.test.ts`.
 *
 * The regression this file exists for: `E2E Tests (Maestro)` is a REQUIRED status
 * check on `main`, and it used to FAIL OPEN. `run-e2e` is a job output, so it is
 * the empty string whenever the `changes` job did not finish successfully, and
 * the skip branch tests `!= "true"`, which an empty string satisfies. So a
 * `changes` job that died on a checkout flake or its own timeout made the
 * required check exit 0, green, having built nothing and run nothing. Nothing
 * else stopped that PR merging, because `Changes` is not itself
 * a required context.
 *
 * A source grep would not have caught it. Every string involved was present, in
 * the right file, next to plausible neighbours. Only running the script with
 * `CHANGES_RESULT=failure` and reading the exit code shows it.
 *
 * Bash is available on the ubuntu runner that hosts the unit tier, and locally
 * through Git Bash on Windows.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url)).replaceAll('\\', '/');
const workflowPath = `${repositoryRoot}.github/workflows/e2e.yml`;

interface GateStep {
  name?: string;
  run?: string;
}
interface GateJob {
  name?: string;
  steps?: GateStep[];
}
interface E2eWorkflow {
  jobs?: Record<string, GateJob>;
}

/**
 * Pulled out of the workflow rather than kept as a copy in `tests/`, so the
 * thing under test is always the script CI actually runs. A duplicated copy
 * would keep passing after the workflow drifted away from it, which is the
 * failure mode this whole file is guarding against.
 */
const GATE_STEP_NAME = 'Gate on suite results';

function readGateScript(): string {
  const workflow = parseYaml(readFileSync(workflowPath, 'utf8')) as E2eWorkflow;
  const gateJob = workflow.jobs?.e2e;
  if (!gateJob) {
    throw new Error("e2e.yml has no `e2e` job. If the gate was renamed, update this test AND main's branch protection.");
  }
  // Selected BY NAME, not as "the first step with a `run:`". The gate job has one
  // run step today, so positional selection works right up until someone adds a
  // setup step above it, at which point this file would quietly start executing
  // that instead and pass while testing nothing. Throwing beats guessing.
  const gateStep = gateJob.steps?.find((step) => step.name === GATE_STEP_NAME);
  if (!gateStep) {
    const found = (gateJob.steps ?? []).map((step) => step.name ?? '(unnamed)').join(', ');
    throw new Error(
      `The \`e2e\` gate job has no step named "${GATE_STEP_NAME}". Found: ${found}. ` +
        'Rename this constant to match, do NOT fall back to picking a step by position.',
    );
  }
  if (typeof gateStep.run !== 'string') {
    throw new Error(`Step "${GATE_STEP_NAME}" has no \`run:\` script to execute.`);
  }
  return gateStep.run;
}

/**
 * On Windows, `bash` on PATH is usually WSL's, which cannot open a `C:/...` path
 * and fails with a "No such file or directory" that reads like a missing file
 * rather than a wrong interpreter. Git Bash can. Paths come from the environment
 * rather than being hardcoded (.claude/rules/no-personal-info.md).
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

interface GateOutcome {
  exitCode: number;
  output: string;
}

interface GateInputs {
  /** `needs.changes.result` */
  changesResult: string;
  /** `needs.changes.outputs.run-e2e`, empty whenever the changes job did not succeed */
  runE2e: string;
  /** `needs.changes.outputs.skip-reason` */
  skipReason: string;
  /** `needs.maestro.result` */
  maestroResult: string;
}

function runGate(inputs: GateInputs): GateOutcome {
  if (!bashExecutable) {
    throw new Error('resolveBashExecutable returned null; the suite should have been skipped.');
  }
  const environment = {
    ...process.env,
    CHANGES_RESULT: inputs.changesResult,
    RUN_E2E: inputs.runE2e,
    SKIP_REASON: inputs.skipReason,
    MAESTRO_RESULT: inputs.maestroResult,
    // The gate appends its coverage table here; the assertions are on the exit
    // code and stdout, so it only needs somewhere harmless to write.
    GITHUB_STEP_SUMMARY: '/dev/null',
  };
  try {
    const output = execFileSync(bashExecutable, ['-c', readGateScript()], {
      encoding: 'utf8',
      env: environment,
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

/** The healthy full run: classifier said build, suites ran, everything green. */
const ALL_GREEN: GateInputs = {
  changesResult: 'success',
  runE2e: 'true',
  skipReason: '',
  maestroResult: 'success',
};

// Skipped rather than failed when no usable bash exists, so a Windows developer
// without Git Bash sees the reason instead of a mystery. The ubuntu runner that
// hosts the unit tier always runs it, so this is never skipped in CI.
describe.skipIf(!bashExecutable)('the E2E Tests (Maestro) required gate', () => {
  it('passes a full run where every suite is green', () => {
    const result = runGate(ALL_GREEN);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('All Maestro suites passed.');
  });

  describe('fails CLOSED when the classifier did not succeed', () => {
    // The whole point. `run-e2e` is empty in every one of these, which is
    // exactly what the skip branch below used to mistake for "docs-only".
    for (const changesResult of ['failure', 'cancelled', 'skipped']) {
      it(`exits non-zero when the changes job reports "${changesResult}"`, () => {
        const result = runGate({
          changesResult,
          runE2e: '',
          skipReason: '',
          maestroResult: '',
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.output).toContain('classifier did not succeed');
      });
    }
  });

  describe('fails when a suite did not pass', () => {
    for (const maestroResult of ['failure', 'cancelled', 'skipped']) {
      it(`exits non-zero when the maestro job reports "${maestroResult}"`, () => {
        const result = runGate({ ...ALL_GREEN, maestroResult });
        expect(result.exitCode).not.toBe(0);
      });
    }
  });

  describe('passes a legitimate skip, and NAMES which one it was', () => {
    // A green check reading only "skipped" invites the reader to assume coverage
    // it did not provide, so each reason has to identify itself.
    for (const skipReason of ['docs', 'draft']) {
      it(`passes, and names the reason, for a "${skipReason}" skip`, () => {
        // Safe for both: a docs-only diff needs no E2E, and GitHub refuses to
        // merge a draft, so nothing can land on either result.
        const result = runGate({
          changesResult: 'success',
          runE2e: 'false',
          skipReason,
          maestroResult: 'skipped',
        });
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain(skipReason);
      });
    }

    it('still passes, but says so, when the reason is missing', () => {
      // Forward compatibility: a future skip path that forgets to set a reason
      // should not silently read as ordinary coverage.
      const result = runGate({
        changesResult: 'success',
        runE2e: 'false',
        skipReason: '',
        maestroResult: 'skipped',
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('no reason given');
    });
  });

  it('reads the gate out of the workflow, not a copy', () => {
    // Non-vacuity guard. If the extraction silently stops finding the script,
    // every assertion above would be running against something else.
    const script = readGateScript();
    expect(script).toContain('CHANGES_RESULT');
    expect(script).toContain('MAESTRO_RESULT');
  });
});
