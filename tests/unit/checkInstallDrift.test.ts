/**
 * The install-drift guard exists because the OBVIOUS way to verify a wall of
 * protocol type errors (stash, re-run, "same before and after, so pre-existing")
 * confirms the wrong answer - both runs resolve the same stale package. So the
 * guard itself has to be tested rather than trusted, or it just relocates the
 * problem.
 *
 * Both halves below reproduce the real 2026-07-27 failure: a worktree under
 * `.kangentic/worktrees/<name>` with no node_modules of its own, resolving
 * @kangentic/protocol 0.10.x out of the main checkout while its package.json
 * declared ^0.11.1.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { findInstalledManifest, satisfiesRange } from '../../scripts/checkInstallDrift.mjs';

const GUARD_SCRIPT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'scripts', 'checkInstallDrift.mjs');

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const directory = temporaryRoots.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function createTemporaryTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'kangentic-drift-'));
  temporaryRoots.push(root);
  return root;
}

function writeInstalledPackage(nodeModulesOwner: string, packageName: string, version: string): string {
  const manifestPath = join(nodeModulesOwner, 'node_modules', ...packageName.split('/'), 'package.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ name: packageName, version }));
  return manifestPath;
}

interface GuardRun {
  status: number;
  stderr: string;
  stdout: string;
}

/**
 * Copies the real guard into a throwaway checkout and RUNS it, because the
 * script derives its project root from its own location. Spawning is the only
 * way to observe what actually matters here: the exit code, and whether the
 * message survives to stderr.
 *
 * Every case below plants a node_modules the walk finds FIRST, so no assertion
 * depends on what happens to exist above the OS temp directory.
 */
function runGuardIn(projectRoot: string, declaredRange: string | null): GuardRun {
  mkdirSync(join(projectRoot, 'scripts'), { recursive: true });
  copyFileSync(GUARD_SCRIPT, join(projectRoot, 'scripts', 'checkInstallDrift.mjs'));
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify(declaredRange ? { dependencies: { '@kangentic/protocol': declaredRange } } : { dependencies: {} }),
  );
  const result = spawnSync(process.execPath, [join(projectRoot, 'scripts', 'checkInstallDrift.mjs')], {
    encoding: 'utf8',
  });
  return { status: result.status ?? -1, stderr: result.stderr, stdout: result.stdout };
}

describe('satisfiesRange', () => {
  it('accepts the installed version this repo actually declares', () => {
    expect(satisfiesRange('0.11.1', '^0.11.1')).toBe(true);
    expect(satisfiesRange('0.11.5', '^0.11.1')).toBe(true);
  });

  it('rejects the exact drift that produced the phantom type errors', () => {
    // The stale main checkout was a minor behind, which is what removed
    // ReadBoardView / SessionSummaryWire / project `groups` from the types.
    expect(satisfiesRange('0.10.9', '^0.11.1')).toBe(false);
  });

  it('treats minor as the breaking axis for 0.x carets, the way npm does', () => {
    // ^0.11.1 must NOT admit 0.12.0. Getting this backwards would make the
    // guard pass on a forward-drifted tree, which breaks types just as badly.
    expect(satisfiesRange('0.12.0', '^0.11.1')).toBe(false);
    expect(satisfiesRange('1.0.0', '^0.11.1')).toBe(false);
  });

  it('uses major as the breaking axis once the package is 1.x', () => {
    expect(satisfiesRange('1.4.0', '^1.2.0')).toBe(true);
    expect(satisfiesRange('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfiesRange('1.1.0', '^1.2.0')).toBe(false);
  });

  it('handles tilde and exact ranges', () => {
    expect(satisfiesRange('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfiesRange('1.3.0', '~1.2.0')).toBe(false);
    expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true);
    expect(satisfiesRange('1.2.4', '1.2.3')).toBe(false);
  });

  it('returns null rather than failing on a range it cannot parse', () => {
    // "Not checked" must never become "definitely broken", or the guard starts
    // reddening npm run typecheck over ranges it simply does not understand.
    expect(satisfiesRange('1.2.3', 'workspace:*')).toBeNull();
    expect(satisfiesRange('1.2.3', '>=1.0.0 <2.0.0')).toBeNull();
    expect(satisfiesRange('not-a-version', '^1.0.0')).toBeNull();
  });
});

describe('findInstalledManifest', () => {
  it('finds a package installed in the checkout itself', () => {
    const root = createTemporaryTree();
    const expected = writeInstalledPackage(root, '@kangentic/protocol', '0.11.1');

    expect(findInstalledManifest('@kangentic/protocol', root)).toBe(expected);
  });

  it('walks up and reports the OUTSIDE path when the worktree has no node_modules', () => {
    // Exactly the real layout: the worktree lives inside the main checkout.
    const mainCheckout = createTemporaryTree();
    const worktree = join(mainCheckout, '.kangentic', 'worktrees', 'some-branch');
    mkdirSync(worktree, { recursive: true });
    const inherited = writeInstalledPackage(mainCheckout, '@kangentic/protocol', '0.10.9');

    const found = findInstalledManifest('@kangentic/protocol', worktree);

    expect(found).toBe(inherited);
    // This is the signal the guard hard-fails on: resolved from outside.
    expect(relative(worktree, String(found)).startsWith('..')).toBe(true);
  });

  it('prefers the worktree copy over the parent when both exist', () => {
    const mainCheckout = createTemporaryTree();
    const worktree = join(mainCheckout, '.kangentic', 'worktrees', 'some-branch');
    mkdirSync(worktree, { recursive: true });
    writeInstalledPackage(mainCheckout, '@kangentic/protocol', '0.10.9');
    const local = writeInstalledPackage(worktree, '@kangentic/protocol', '0.11.1');

    const found = findInstalledManifest('@kangentic/protocol', worktree);

    expect(found).toBe(local);
    expect(relative(worktree, String(found)).startsWith('..')).toBe(false);
  });

  it('returns null when nothing is installed anywhere up the chain', () => {
    const root = createTemporaryTree();
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });

    expect(findInstalledManifest('@kangentic/definitely-not-installed', nested)).toBeNull();
  });
});

/**
 * The guard as a PROCESS. The helpers above prove the logic; these prove the
 * two things only a real run can show, and that a `pretypecheck` hook lives or
 * dies by: the exit code, and whether the explanation reaches stderr at all.
 *
 * That second one is not hypothetical. `fail()` sets `process.exitCode` and
 * returns rather than calling `process.exit()`, because on Windows a
 * TTY-attached stderr is asynchronous, so exiting immediately can truncate the
 * very message the guard exists to print.
 */
describe('checkInstallDrift as a process', () => {
  it('exits 0 and reports the resolved package when the install is healthy', () => {
    const root = createTemporaryTree();
    writeInstalledPackage(root, '@kangentic/protocol', '0.11.1');

    const run = runGuardIn(root, '^0.11.1');

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('@kangentic/protocol@0.11.1 satisfies ^0.11.1');
  });

  it('exits 1 and names the version drift that produced the phantom type errors', () => {
    const root = createTemporaryTree();
    writeInstalledPackage(root, '@kangentic/protocol', '0.10.9');

    const run = runGuardIn(root, '^0.11.1');

    expect(run.status).toBe(1);
    // The whole message, not just a non-zero code: asserting the tail proves
    // nothing was cut off mid-write on the way out.
    expect(run.stderr).toContain('Stale dependency install detected');
    expect(run.stderr).toContain('installed at 0.10.9, which does not satisfy ^0.11.1');
    expect(run.stderr).toContain('npm install');
  });

  it('exits 1 when the package resolves from OUTSIDE the checkout', () => {
    // The real 2026-07-27 layout: a worktree nested inside the main checkout,
    // with no node_modules of its own, inheriting the parent's.
    const mainCheckout = createTemporaryTree();
    writeInstalledPackage(mainCheckout, '@kangentic/protocol', '0.11.1');
    const worktree = join(mainCheckout, '.kangentic', 'worktrees', 'some-branch');
    mkdirSync(worktree, { recursive: true });

    const run = runGuardIn(worktree, '^0.11.1');

    // Note the installed version SATISFIES the range here - being outside the
    // checkout is disqualifying on its own, because the next branch that tree
    // checks out can move it.
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('resolves from OUTSIDE this checkout');
  });

  it('exits 0 without checking anything when the probe package is not a dependency', () => {
    const root = createTemporaryTree();

    const run = runGuardIn(root, null);

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
  });
});
