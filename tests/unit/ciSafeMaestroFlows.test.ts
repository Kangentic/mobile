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
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const e2eWorkflowSource = readFileSync(`${repositoryRoot}.github/workflows/e2e.yml`, 'utf8');

/** Entries proven to run on a GitHub runner. */
const CI_SAFE_ENTRIES = ['.maestro/smoke.yaml', '.maestro/paired'];

function readWorkflowFlowEntries(): string[] {
  const entries: string[] = [];

  // The smoke suite's matrix. Text-parsed rather than via a YAML dependency,
  // matching buildWorkflow.test.ts.
  for (const match of e2eWorkflowSource.matchAll(/^\s*(?:- )?flows:\s*(\S+)\s*$/gm)) {
    entries.push(match[1]);
  }

  // The paired suite's script invocation: the flows directory is the trailing
  // literal argument on the run-maestro-paired.sh line, not a `flows:` key.
  const pairedInvocation = e2eWorkflowSource.match(/run-maestro-paired\.sh\b.*?(\.maestro\/\S+)\s*$/m);
  if (pairedInvocation) entries.push(pairedInvocation[1]);

  return entries;
}

describe('CI runs only the Maestro entries this guard knows about', () => {
  it('finds both entries', () => {
    // Non-vacuity guard, raised to 2 (was 1): a scan that silently stops
    // matching the paired entry is worse than no scan, because the smoke
    // entry alone would still satisfy a bare ">0" check.
    expect(readWorkflowFlowEntries().length).toBeGreaterThanOrEqual(2);
  });

  it('runs only allowlisted entries', () => {
    for (const entry of readWorkflowFlowEntries()) {
      expect(CI_SAFE_ENTRIES).toContain(entry);
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

  it('every allowlisted entry exists on disk, as a file or a directory', () => {
    // A renamed flow or directory would otherwise fail deep into a run, after
    // building an APK and booting an emulator, with a Maestro parse error.
    for (const entry of CI_SAFE_ENTRIES) {
      expect(existsSync(`${repositoryRoot}${entry}`)).toBe(true);
    }
  });
});
