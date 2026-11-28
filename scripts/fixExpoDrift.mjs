#!/usr/bin/env node
/**
 * The one fix for main falling behind Expo's live SDK version list.
 *
 * Expo changes the versions it expects for an SDK on its own server, with no commit
 * in this repository: 22 realignments between 2026-07-25 and 2026-11-28. The required
 * `Native config (prebuild)` check reads that list OFFLINE, so it no longer goes red
 * when that happens. .github/workflows/expo-drift.yml checks main against the LIVE
 * list every day and opens an issue when it moves. This script is the fix that issue
 * names. It does, in order:
 *
 *   1. `npx expo install --fix`. Two rounds is normal, and the CLI runs the second
 *      itself: the first bump changes which `expo` resolves the mapping, and the
 *      newer one can ask for more.
 *   2. For each `patches/<package>+<version>.patch` whose package moved, `git mv` it
 *      to the new version's name. A patch filename pins its version: patch-package
 *      only warns on a mismatch while the hunk still applies, and CI's node_modules
 *      cache key hashes patches/**, so the rename belongs in the same commit as the
 *      lockfile.
 *   3. `npx patch-package --error-on-fail`, which re-applies every patch (one that
 *      is already applied passes) and exits non-zero when a hunk no longer fits. That
 *      is the point where a person must check the guarded call site before anything
 *      ships; see the expo-task-manager note under patches/ in CLAUDE.md.
 *   4. The ONLINE `npx expo install --check`, whose exit code this script returns.
 *
 * EXPO_OFFLINE is removed from every command's environment, so a shell that carries
 * it cannot turn the fix or the final check into the offline variant.
 *
 * WHERE IT RUNS: a fresh worktree off origin/main with its own `npm ci`, outside the
 * main checkout and never at a drive root. The commands are in the drift issue's body
 * and in docs/developer-guide.md ("Expo's live version list").
 *
 * Never in a task worktree. Its node_modules is normally a junction to the main
 * checkout's, so the installed versions it compares belong to whatever that tree
 * holds (this script refuses a linked node_modules for that reason). And a Gradle
 * daemon from a local build there once held a jar under node_modules and failed the
 * install with EBUSY (2026-10-03). Commit the result as its own `chore(deps)` commit
 * on its own branch; a release takes it as its own commit in the release PR instead
 * (.claude/skills/release/SKILL.md, Step 1).
 *
 * Usage: node scripts/fixExpoDrift.mjs
 * Exit 0 when the online check passes after the fix; 1 when any step fails.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { isEntrypoint } from './lib/is-entrypoint.mjs';
import { onlineEnvironment } from './lib/onlineEnvironment.mjs';
import { patchedPackages, stalePatches } from './upgrade-deps.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PATCH_HINT =
  'A patch no longer applies to the version Expo now expects. Check the call site it guards before anything ships: ' +
  'for expo-task-manager that is the null HeadlessAppLoader guard in TaskService.executeTask (see the patches/ note in CLAUDE.md). ' +
  'Regenerate the hunk against the new version, name the file after that version, and commit both with the lockfile.';

/**
 * @typedef {{ name: string, file: string, patchedVersion: string, resolved: string | null }} StalePatch
 * @typedef {{ name: string, from: string, to: string }} PatchRename
 */

/**
 * The renames that make each stale patch's filename name the version now installed.
 *
 * Only the trailing `+<version>.patch` of the ORIGINAL filename is swapped, so the
 * scoped `@scope+name+1.0.0.patch` form keeps its prefix, which a name rebuilt from
 * the package name would lose. (A nested `parent++child` name would keep its prefix
 * too, but planPatchRenames refuses those before they get here.)
 *
 * @param {StalePatch[]} stale what stalePatches() returns
 * @returns {{ renames: PatchRename[], problems: string[] }}
 */
export function patchRenames(stale) {
  /** @type {PatchRename[]} */
  const renames = [];
  /** @type {string[]} */
  const problems = [];
  for (const { name, file, patchedVersion, resolved } of stale) {
    if (resolved === null) {
      problems.push(`${file} patches ${name}, which the lockfile no longer installs. Remove the patch or restore the package.`);
      continue;
    }
    const versionSuffix = `+${patchedVersion}.patch`;
    if (!file.endsWith(versionSuffix)) {
      problems.push(`${file} does not end in ${versionSuffix}, so it cannot be renamed safely. Rename it by hand.`);
      continue;
    }
    renames.push({ name, from: file, to: `${file.slice(0, -versionSuffix.length)}+${resolved}.patch` });
  }
  return { renames, problems };
}

/**
 * The renames for a patches/ listing, or the problems that stop the script before a
 * single `git mv`. Three things stop it, checked in this order:
 *
 *   - A nested patch (`parent++child+1.0.0.patch`). Its child's lockfile entry is
 *     `node_modules/parent/node_modules/child`, but the shared parser in
 *     upgrade-deps.mjs keys it by `child` alone, so a hoisted copy's version would
 *     decide the rename, silently. None exists today; rename one by hand.
 *   - A patched package whose installed version is not the lockfile's (see
 *     installedVersionMismatches).
 *   - A stale patch patchRenames() cannot rename.
 *
 * Any problem means no renames at all, so the patches never end up half renamed.
 *
 * @param {string[]} patchFileNames the entries of patches/
 * @param {Record<string, { version?: string }>} lockPackages package-lock.json's `packages`
 * @param {(packageName: string) => string | null} readInstalledVersion
 * @returns {{ renames: PatchRename[], problems: string[] }}
 */
export function planPatchRenames(patchFileNames, lockPackages, readInstalledVersion) {
  const nestedPatches = patchFileNames.filter((fileName) => fileName.endsWith('.patch') && fileName.includes('++'));
  if (nestedPatches.length > 0) {
    return {
      renames: [],
      problems: nestedPatches.map(
        (fileName) =>
          `patches/${fileName} patches a nested package, which this script cannot look up in the lockfile. Rename it by hand.`
      ),
    };
  }

  const patched = patchedPackages(patchFileNames);
  const mismatches = installedVersionMismatches(Object.keys(patched), lockPackages, readInstalledVersion);
  if (mismatches.length > 0) {
    return {
      renames: [],
      problems: [
        ...mismatches.map(
          ({ name, locked, installed }) =>
            `${name}: the lockfile has ${locked ?? 'nothing'}, node_modules has ${installed ?? 'nothing'}.`
        ),
        'node_modules disagrees with the lockfile, so no patch was renamed. Run `npm ci` and start again.',
      ],
    };
  }

  const { renames, problems } = patchRenames(stalePatches(patched, lockPackages));
  return problems.length > 0 ? { renames: [], problems } : { renames, problems };
}

/**
 * Patched packages whose installed version is not the lockfile's. The renames are
 * computed from the lockfile, which is what the commit carries, so a node_modules
 * that disagrees with it would rename a patch to a version nothing installs.
 *
 * @param {string[]} packageNames the packages patches/ patches
 * @param {Record<string, { version?: string }>} lockPackages package-lock.json's `packages`
 * @param {(packageName: string) => string | null} readInstalledVersion
 * @returns {{ name: string, locked: string | null, installed: string | null }[]}
 */
export function installedVersionMismatches(packageNames, lockPackages, readInstalledVersion) {
  return packageNames.flatMap((name) => {
    const locked = lockPackages[`node_modules/${name}`]?.version ?? null;
    const installed = readInstalledVersion(name);
    return locked === installed ? [] : [{ name, locked, installed }];
  });
}

/**
 * @param {string} command a fixed command line, run through the shell so `npx`
 *   resolves on Windows as well as Linux
 * @returns {number} the exit code
 */
function runCommand(command) {
  process.stdout.write(`\n> ${command}\n`);
  const result = spawnSync(command, {
    cwd: REPOSITORY_ROOT,
    env: onlineEnvironment(process.env),
    shell: true,
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

/** @param {string} message */
function reportError(message) {
  process.stderr.write(`fixExpoDrift: ${message}\n`);
}

/** @param {string} packageName */
function readInstalledVersion(packageName) {
  const manifestPath = path.join(REPOSITORY_ROOT, 'node_modules', packageName, 'package.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return typeof manifest.version === 'string' ? manifest.version : null;
}

/** @returns {number} the exit code */
function main() {
  const nodeModulesPath = path.join(REPOSITORY_ROOT, 'node_modules');
  if (!existsSync(nodeModulesPath)) {
    reportError('there is no node_modules here. Run `npm ci` first, in a fresh worktree off origin/main.');
    return 1;
  }
  // Node reports a Windows junction as a symbolic link.
  if (lstatSync(nodeModulesPath).isSymbolicLink()) {
    reportError(
      'node_modules is a link to another checkout, so the versions installed here are not this lockfile\'s. ' +
        'Run this in a fresh worktree off origin/main with its own `npm ci`, never over a junction.'
    );
    return 1;
  }

  if (runCommand('npx expo install --fix') !== 0) {
    reportError('`npx expo install --fix` failed. If the output above names patch-package, read this:');
    reportError(PATCH_HINT);
    return 1;
  }

  const lockPackages = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, 'package-lock.json'), 'utf8')).packages ?? {};
  const patchesDirectory = path.join(REPOSITORY_ROOT, 'patches');
  const patchFileNames = existsSync(patchesDirectory) ? readdirSync(patchesDirectory) : [];

  const { renames, problems } = planPatchRenames(patchFileNames, lockPackages, readInstalledVersion);
  if (problems.length > 0) {
    for (const problem of problems) reportError(problem);
    return 1;
  }
  for (const { name, from, to } of renames) {
    process.stdout.write(`\n> git mv ${from} ${to}   (${name} moved)\n`);
    execFileSync('git', ['mv', from, to], { cwd: REPOSITORY_ROOT, stdio: 'inherit' });
  }
  if (renames.length === 0) process.stdout.write('\nNo patched package moved, so no patch was renamed.\n');

  if (runCommand('npx patch-package --error-on-fail') !== 0) {
    reportError(PATCH_HINT);
    return 1;
  }

  const checkExitCode = runCommand('npx expo install --check');
  process.stdout.write('\n> git status --short\n');
  execFileSync('git', ['status', '--short'], { cwd: REPOSITORY_ROOT, stdio: 'inherit' });
  if (checkExitCode !== 0) {
    reportError('the online check still finds drift after the fix. Read its output above.');
  }
  return checkExitCode;
}

if (isEntrypoint(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
