#!/usr/bin/env node
/**
 * Fail fast when this checkout is type-checking against somebody else's
 * dependencies.
 *
 * Every kangentic worktree lives under `.kangentic/worktrees/<name>`, which is
 * INSIDE the main checkout. So when a worktree has no `node_modules` of its
 * own, Node's bare-specifier resolution simply walks up and finds the main
 * checkout's copy - which belongs to whatever branch that tree is on and can
 * be several minor versions behind what this worktree's package.json declares.
 *
 * The symptom is a wall of errors in files nobody touched:
 *
 *   error TS2305: Module '"@kangentic/protocol"' has no exported member 'ReadBoardView'.
 *   error TS2339: Property 'groups' does not exist on type 'ReadBoardProjectListResponsePayload'.
 *
 * The reason this needs a mechanical check rather than a docs note is that the
 * OBVIOUS way to verify those errors confirms the wrong answer. Stashing the
 * working changes and re-running "to see if they are pre-existing" succeeds -
 * the errors are identical before and after - which reads as proof the baseline
 * is simply broken and should be worked around. It proves nothing: both runs
 * resolve the same stale package. CI is green the whole time, because `npm ci`
 * always produces a local, correct tree.
 *
 * Deliberately narrow. It hard-fails on exactly the two things that produced
 * that wall, and checks nothing else, so it can never redden `npm run
 * typecheck` over cosmetic drift:
 *   1. dependencies resolving from OUTSIDE this checkout, and
 *   2. an installed @kangentic/protocol that does not satisfy its declared range.
 *
 * Dependency-free on purpose (see checkPlayVersionCode.mjs): a guard that can
 * itself fail to load is worse than no guard.
 *
 * Usage:
 *   node scripts/checkInstallDrift.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One package is enough for the "whose node_modules is this" question: a
 * checkout either has its own tree or it does not, and every bare specifier
 * resolves through the same chain. @kangentic/protocol is the right probe
 * because it is also the fastest-moving dependency, so it is the one whose
 * staleness actually shows up as type errors.
 */
const PROBE_PACKAGE = '@kangentic/protocol';

/**
 * Node's own algorithm for a bare specifier: walk up from the importing
 * directory, taking the first `node_modules/<name>` that exists. Reimplemented
 * rather than using require.resolve so the answer is the PATH that wins, which
 * is the whole question here - and so package `exports` cannot block reading
 * the manifest.
 */
export function findInstalledManifest(packageName, startDirectory) {
  let directory = startDirectory;
  for (;;) {
    const manifestPath = join(directory, 'node_modules', ...packageName.split('/'), 'package.json');
    if (existsSync(manifestPath)) return manifestPath;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * Minimal `^`/`~`/exact matcher. Anything more exotic returns null, meaning
 * "not checked" - this guard only ever hard-fails on a definite mismatch.
 *
 * On the `^` and `~` branches a prerelease suffix is ignored (only the numeric
 * prefix is compared), which is imprecise but never produces a false failure on
 * a release version. The exact-pin branch is a raw string compare, so it does
 * NOT ignore the suffix and would reject 1.2.3-beta.1 against a pin of 1.2.3.
 * Unreachable today - the probe package is declared as a caret range - and left
 * strict on purpose, since an exact pin asks for exactly that version.
 */
export function satisfiesRange(version, range) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const installed = parse(version);
  const declared = parse(range.replace(/^[\^~]/, ''));
  if (!installed || !declared) return null;
  if (!/^[\^~]?\d/.test(range)) return null;

  const isBelowMinimum =
    installed[0] < declared[0] ||
    (installed[0] === declared[0] && installed[1] < declared[1]) ||
    (installed[0] === declared[0] && installed[1] === declared[1] && installed[2] < declared[2]);
  if (isBelowMinimum) return false;

  if (range.startsWith('^')) {
    // npm treats 0.x as "minor is the breaking axis", which matters here:
    // @kangentic/protocol is 0.x, so ^0.11.1 does NOT admit 0.12.0.
    if (declared[0] === 0) return installed[0] === 0 && installed[1] === declared[1];
    return installed[0] === declared[0];
  }
  if (range.startsWith('~')) return installed[0] === declared[0] && installed[1] === declared[1];
  return version === range;
}

/**
 * Sets the failing exit code and returns, rather than calling process.exit().
 * On Windows a TTY-attached stderr is ASYNCHRONOUS (Node's own process.stderr
 * docs), so process.exit() can cut the write short - and this guard's entire
 * value is the message, not the code. Returning lets the event loop drain the
 * write and Node exit 1 on its own. Every caller must therefore `return
 * fail(...)`, since this no longer stops execution by itself.
 */
function fail(lines) {
  console.error(`\n  Stale dependency install detected\n`);
  for (const line of lines) console.error(`  ${line}`);
  console.error('');
  process.exitCode = 1;
}

function main() {
  const rootManifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  const declaredRange = { ...rootManifest.dependencies, ...rootManifest.devDependencies }[PROBE_PACKAGE];
  if (!declaredRange) {
    // The probe is no longer a dependency; nothing meaningful to assert.
    return;
  }

  const manifestPath = findInstalledManifest(PROBE_PACKAGE, projectRoot);
  if (!manifestPath) {
    return fail([`${PROBE_PACKAGE} is not installed anywhere on the resolution path.`, '', 'Run:  npm install']);
  }

  if (relative(projectRoot, manifestPath).startsWith('..')) {
    return fail([
      `${PROBE_PACKAGE} resolves from OUTSIDE this checkout:`,
      `  ${manifestPath}`,
      '',
      'This worktree has no node_modules of its own, so Node walked up and found',
      "another checkout's - which tracks a different branch and can be behind the",
      'versions this package.json declares. Any type errors you are about to read',
      'may belong to that tree, not to your work.',
      '',
      'Run:  npm install',
    ]);
  }

  const installedVersion = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
  // Strict `=== false`, never `!satisfiesRange(...)`: null means "this range
  // is one I do not parse", and collapsing that into a failure is exactly the
  // false redding-of-typecheck this guard promises never to cause.
  if (satisfiesRange(installedVersion, declaredRange) === false) {
    return fail([
      `${PROBE_PACKAGE} is installed at ${installedVersion}, which does not satisfy ${declaredRange}.`,
      `  ${manifestPath}`,
      '',
      'Run:  npm install',
    ]);
  }

  const location = relative(projectRoot, manifestPath).split(sep).slice(0, -1).join('/');
  console.log(`Dependency check: ${PROBE_PACKAGE}@${installedVersion} satisfies ${declaredRange} (${location})`);
}

// Importable for tests (tests/unit/checkInstallDrift.test.ts) without running
// the check or its process.exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
