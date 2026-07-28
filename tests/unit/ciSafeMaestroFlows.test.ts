/**
 * Guards which Maestro entries `.github/workflows/e2e.yml` is allowed to run.
 *
 * Two suite entries are proven safe on a GitHub runner: `.maestro/smoke.yaml`
 * (the `maestro` job's matrix) and `.maestro/paired` (the `maestro-paired`
 * job's script invocation, which checks out the relay and pairs to
 * `scripts/stubDesktopPeer.mjs` before running it - see
 * `.github/scripts/run-maestro-paired.sh`). `.maestro/setup/pairing-bootstrap.yaml`
 * is NOT a suite entry: it is a rig fixture that needs a `PAIRING_URI` handed
 * to it, invoked once by name from inside `run-maestro-paired.sh`, never as a
 * top-level workflow entry.
 *
 * This is an ALLOWLIST on purpose. A blocklist would need updating every time
 * an entry is added, and forgetting is silent: a bare `.maestro` entry would
 * sweep in the setup fixture, which then fails for lacking `PAIRING_URI` and
 * reads as a broken pairing screen rather than a misconfigured workflow.
 *
 * The paired job has no matrix, so its flows directory is not a `flows:` key
 * like the smoke job's - it is a literal argument to
 * `run-maestro-paired.sh` in the job's `script:` step. This guard has to
 * scan for that too, or it silently stops covering the paired entry the
 * moment the smoke matrix entry alone satisfies the non-vacuity check.
 *
 * The allowlists are kept PER JOB, not pooled. The required gate exits on
 * `needs.maestro.result`, so a `flows: .maestro/paired` line added to the
 * `maestro` job's matrix puts all 11 flows behind the required check just as
 * surely as adding `maestro-paired` to the gate's `needs:` does. A single
 * pooled allowlist accepted that silently, because the entry was on it for
 * the other job's sake. Which job may run an entry is the thing being
 * guarded, so it is what the lists encode.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const e2eWorkflowSource = readFileSync(`${repositoryRoot}.github/workflows/e2e.yml`, 'utf8');
const iosWorkflowSource = readFileSync(`${repositoryRoot}.github/workflows/build-ios.yml`, 'utf8');
const maestroRuleSource = readFileSync(`${repositoryRoot}.claude/rules/e2e-maestro-runs.md`, 'utf8');

/**
 * Entries the REQUIRED `E2E Tests (Maestro)` gate may run, via the `maestro` job's
 * matrix. Deliberately narrower than the advisory list: everything here feeds
 * `needs.maestro.result`, which the gate exits non-zero on, so an entry added
 * here can block every merge in the repository.
 */
const REQUIRED_GATE_SAFE_ENTRIES = ['.maestro/smoke.yaml'];

/** Entries the advisory `maestro-paired` job may run. A red run here blocks nothing. */
const ADVISORY_SAFE_ENTRIES = ['.maestro/paired'];

/** Every entry either job may run. */
const CI_SAFE_ENTRIES = [...REQUIRED_GATE_SAFE_ENTRIES, ...ADVISORY_SAFE_ENTRIES];

/**
 * The job names listed in the required `E2E Tests (Maestro)` gate's `needs:`.
 * Text-parsed for the same reason as the flow entries below.
 */
function readRequiredGateNeeds(): string[] {
  const gate = e2eWorkflowSource.match(/name:\s*E2E Tests \(Maestro\)\s*\n\s*needs:\s*\[([^\]]*)\]/);
  if (gate === null) return [];
  return gate[1]
    .split(',')
    .map((jobName) => jobName.trim())
    .filter((jobName) => jobName.length > 0);
}

/**
 * Entries run by the `maestro` job, whose result the required gate reads.
 * Text-parsed rather than via a YAML dependency, matching buildWorkflow.test.ts.
 *
 * The scan is FILE-WIDE and assumes `maestro` is the only job with a `flows:`
 * key, which it is today (one match in e2e.yml). That assumption is what lets
 * a regex stand in for "belongs to the job the gate needs". If a THIRD job
 * with its own `flows:` key is ever added, entries meant for it will surface
 * here and be rejected against the required-gate allowlist. The fix then is to
 * scope this scan to the `maestro` job's block, NOT to widen
 * `REQUIRED_GATE_SAFE_ENTRIES` - widening it reopens the exact door the split
 * allowlists close.
 */
function readRequiredGateFlowEntries(): string[] {
  return [...e2eWorkflowSource.matchAll(/^\s*(?:- )?flows:\s*(\S+)\s*$/gm)].map((match) => match[1]);
}

/**
 * Entries run by the advisory `maestro-paired` job. It has no matrix, so its
 * flows directory is not a `flows:` key like the smoke job's - it is the
 * trailing literal argument on the `run-maestro-paired.sh` line.
 */
function readAdvisoryFlowEntries(): string[] {
  const pairedInvocation = e2eWorkflowSource.match(/run-maestro-paired\.sh\b.*?(\.maestro\/\S+)\s*$/m);
  return pairedInvocation ? [pairedInvocation[1]] : [];
}

function readWorkflowFlowEntries(): string[] {
  return [...readRequiredGateFlowEntries(), ...readAdvisoryFlowEntries()];
}

describe('CI runs only the Maestro entries this guard knows about', () => {
  it('finds both entries', () => {
    // Non-vacuity guard, asserting MEMBERSHIP rather than a count. A count is
    // the weaker form: `>= 2` also passes when the paired regex has silently
    // stopped matching and a second smoke matrix entry has been added, which
    // is exactly the drift this guard exists to notice.
    expect(readRequiredGateFlowEntries()).toContain('.maestro/smoke.yaml');
    expect(readAdvisoryFlowEntries()).toContain('.maestro/paired');
  });

  it('keeps the paired suite out of the REQUIRED gate job', () => {
    // The gate reads `needs.maestro.result`, so a paired entry added to the
    // `maestro` job's matrix routes all 11 flows into the required check just
    // as surely as adding `maestro-paired` to the gate's `needs:` does. The
    // separate allowlist is what closes that second door; a single combined
    // allowlist accepted this silently.
    for (const entry of readRequiredGateFlowEntries()) {
      expect(REQUIRED_GATE_SAFE_ENTRIES).toContain(entry);
    }
  });

  it('runs only allowlisted entries in the advisory job', () => {
    for (const entry of readAdvisoryFlowEntries()) {
      expect(ADVISORY_SAFE_ENTRIES).toContain(entry);
    }
  });

  it('never runs the pairing-bootstrap fixture as a top-level suite entry', () => {
    // Stated separately from the allowlist so the failure message names the
    // actual hazard rather than just "not in the list".
    for (const entry of readWorkflowFlowEntries()) {
      expect(entry).not.toContain('setup');
    }
  });

  it('never points at a bare .maestro root, which would sweep in the setup fixture', () => {
    for (const entry of readWorkflowFlowEntries()) {
      expect(entry).not.toMatch(/^\.maestro\/?$/);
    }
  });

  it('finds the required gate\'s needs at all', () => {
    // Non-vacuity guard for the assertion below, which is otherwise vacuously
    // true the moment the gate job is reformatted out of this regex's reach.
    expect(readRequiredGateNeeds().length).toBeGreaterThan(0);
  });

  it('keeps the advisory paired job OUT of the required gate', () => {
    // The whole safety design of the paired suite. `E2E Tests (Maestro)` is a
    // required check on `main`, so anything in its `needs:` can block every
    // merge in the repository. The paired suite is 11 flows against a relay, a
    // stub peer, and an emulator, and it has no CI track record yet, so it
    // reports its own advisory check instead.
    //
    // This test failing is the intended cost of PROMOTING that job once it has
    // been green across several PRs: delete this assertion in the same change
    // that adds `maestro-paired` to the gate. That is the point - promotion
    // should be a deliberate edit, not a side effect.
    expect(readRequiredGateNeeds()).not.toContain('maestro-paired');
  });

  it('every allowlisted entry exists on disk, as a file or a directory', () => {
    // A renamed flow or directory would otherwise fail deep into a run, after
    // building an APK and booting an emulator, with a Maestro parse error.
    for (const entry of CI_SAFE_ENTRIES) {
      expect(existsSync(`${repositoryRoot}${entry}`)).toBe(true);
    }
  });
});

/**
 * The E2E RUNNER is pinned, not just the flows it runs.
 *
 * `curl -Ls https://get.maestro.mobile.dev` installs `releases/latest` when
 * MAESTRO_VERSION is unset, so an unpinned workflow installs whatever Maestro
 * shipped that morning. `E2E Tests (Maestro)` is a REQUIRED status check, so a
 * release in someone else's repository could turn it red overnight with no
 * commit here - the exact hazard e2e.yml pins the relay checkout to a SHA to
 * avoid, arriving through the tool rather than a sibling repo.
 *
 * Two jobs install Maestro, which is why the pin lives in a workflow-level
 * `env:` instead of twice at step level: one literal cannot drift from the
 * other if there is only one literal. These assertions cover what is left -
 * that it exists, that no job shadows it, and that CI and a developer's laptop
 * are told to run the same version.
 */
interface WorkflowEnvelope {
  env?: Record<string, string>;
  jobs?: Record<string, { env?: Record<string, string>; steps?: { run?: string }[] }>;
}

function readE2eWorkflow(): WorkflowEnvelope {
  return parseYaml(e2eWorkflowSource) as WorkflowEnvelope;
}

/** Jobs with a step that runs the Maestro installer. */
function readJobsInstallingMaestro(): string[] {
  const jobs = readE2eWorkflow().jobs ?? {};
  return Object.entries(jobs)
    .filter(([, job]) => (job.steps ?? []).some((step) => step.run?.includes('get.maestro.mobile.dev')))
    .map(([jobName]) => jobName);
}

describe('the Maestro CLI is pinned, not floating', () => {
  it('declares a concrete version at workflow level', () => {
    // A bare `x.y.z`. The installer prefixes it to resolve
    // `releases/download/cli-<version>/maestro.zip`, so a value carrying the
    // `cli-` prefix already would 404 and redden the required check.
    expect(readE2eWorkflow().env?.MAESTRO_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('finds the jobs that install it', () => {
    // Non-vacuity guard. Every assertion below iterates this list, so an
    // extraction that silently stops matching would leave them all trivially
    // true while the pin went unenforced.
    expect(readJobsInstallingMaestro()).toEqual(expect.arrayContaining(['maestro', 'maestro-paired']));
  });

  it('lets no job shadow the pin with its own MAESTRO_VERSION', () => {
    // A job-level `env:` wins over the workflow-level one, so this is how a
    // single job could quietly go back to floating while the top of the file
    // still reads as pinned.
    const jobs = readE2eWorkflow().jobs ?? {};
    for (const jobName of readJobsInstallingMaestro()) {
      expect(jobs[jobName]?.env?.MAESTRO_VERSION).toBeUndefined();
    }
  });

  it('installs the same version the local recipe tells a developer to run', () => {
    // Pinning CI without pinning the local instruction just moves the problem:
    // a developer on a newer CLI writes a flow that passes on their machine and
    // fails the gate, and nothing in either place explains why. The rule file is
    // where the local recipe is read, so it carries the same number.
    const pinnedInCi = readE2eWorkflow().env?.MAESTRO_VERSION;
    expect(maestroRuleSource).toContain(`Maestro ${pinnedInCi}`);
  });

  it('runs the iOS smoke flow on that same version', () => {
    // build-ios.yml runs `.maestro/smoke.yaml` too, on a macOS runner. Two
    // platforms on two Maestro versions means the next iOS-only flow failure
    // gets attributed to iOS when the variable that actually differed was the
    // tool. That workflow is dispatch-only and cannot block a PR, which is why
    // it is asserted here rather than given its own guard - the point is that
    // the versions agree, not that iOS has a gate.
    const iosWorkflow = parseYaml(iosWorkflowSource) as WorkflowEnvelope;
    expect(iosWorkflow.env?.MAESTRO_VERSION).toBe(readE2eWorkflow().env?.MAESTRO_VERSION);
  });
});
