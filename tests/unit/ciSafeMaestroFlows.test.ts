/**
 * Guards which Maestro flows CI is allowed to run.
 *
 * Only a subset of the suite is safe on a GitHub runner. `.maestro/smoke.yaml`
 * works against a fresh unpaired install with no relay and no peer.
 * `.maestro/paired/**` does not: every one of those flows needs a local relay, a
 * running `scripts/stubDesktopPeer.mjs`, and a completed pairing ceremony, none of
 * which exist on a runner. `.maestro/setup/pairing-bootstrap.yaml` is not a test at
 * all; it is a rig fixture that needs a `PAIRING_URI` handed to it.
 *
 * This is an ALLOWLIST on purpose. A blocklist would need updating every time a
 * flow is added, and forgetting is silent: `flows: .maestro/` would sweep in the
 * paired suite, which then fails for environmental reasons and reads as a product
 * regression. Worse, `E2E tests (Maestro)` is a required check on `main`, so a
 * suite that cannot pass in CI blocks every merge in the repository.
 *
 * When paired flows do become runnable in CI (relay checked out, stub peer
 * started, and the `usesCleartextTraffic` carve-out landed), add the entry here in
 * the same change as the workflow. That is the point of the test: widening what CI
 * runs should be a deliberate edit, not a side effect.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const e2eWorkflowSource = readFileSync(`${repositoryRoot}.github/workflows/e2e.yml`, 'utf8');

/** Flows proven to run on a GitHub runner with no external dependencies. */
const CI_SAFE_FLOWS = ['.maestro/smoke.yaml'];

function readWorkflowFlowEntries(): string[] {
  // Text-parsed rather than via a YAML dependency, matching buildWorkflow.test.ts.
  return [...e2eWorkflowSource.matchAll(/^\s*(?:- )?flows:\s*(\S+)\s*$/gm)].map((match) => match[1]);
}

describe('CI runs only the Maestro flows that can pass there', () => {
  it('finds the flow entries at all', () => {
    // Non-vacuity guard. A scan that silently stops matching is worse than no
    // scan: it reports success forever while checking nothing.
    expect(readWorkflowFlowEntries().length).toBeGreaterThan(0);
  });

  it('runs only allowlisted flows', () => {
    for (const entry of readWorkflowFlowEntries()) {
      expect(CI_SAFE_FLOWS).toContain(entry);
    }
  });

  it('never points at a directory, which would sweep in the paired suite', () => {
    for (const entry of readWorkflowFlowEntries()) {
      expect(entry).toMatch(/\.yaml$/);
    }
  });

  it('never runs a paired flow or the pairing fixture', () => {
    // Stated separately from the allowlist so the failure message names the actual
    // hazard rather than just "not in the list".
    for (const entry of readWorkflowFlowEntries()) {
      expect(entry).not.toContain('paired');
      expect(entry).not.toContain('setup');
    }
  });

  it('every allowlisted flow exists', () => {
    // A renamed flow would otherwise fail 15 minutes into a run, after building an
    // APK and booting an emulator, with a Maestro parse error.
    for (const flow of CI_SAFE_FLOWS) {
      expect(() => readFileSync(`${repositoryRoot}${flow}`, 'utf8')).not.toThrow();
    }
  });
});
