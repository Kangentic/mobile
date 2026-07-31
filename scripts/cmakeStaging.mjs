#!/usr/bin/env node
/**
 * Prune and verify the relocated CMake staging root.
 *
 * `plugins/withAndroidCmakeBuildStaging.ts` moves every module's `.cxx`
 * directory out of the checkout and onto a short absolute root, keyed by a hash
 * of the checkout path so parallel Kangentic worktrees never collide. That is
 * what lets a build succeed from any path depth, and it has one cost worth
 * owning: the output now escapes both `gradlew clean` and the project
 * directory, and Kangentic mints a new hash per branch, so without a prune the
 * root grows one large tree per branch forever.
 *
 * VERIFY exists because the failure mode of this fix is the flag not ARRIVING,
 * not the flag being wrong. A silent non-application looks exactly like a
 * working build until the path that needed shortening shows up. It checks only
 * the trees belonging to the checkout it runs from: the root is shared, so
 * scanning all of it would fail your correct build over a sibling branch's
 * stale one and name a file you have never seen.
 *
 * Dependency-free on purpose (see checkInstallDrift.mjs): a guard that can
 * itself fail to load is worse than no guard.
 *
 * Usage (run from the checkout root - --verify scopes itself to the checkout it
 * is invoked from, so a subdirectory matches no staging tree and fails):
 *   node scripts/cmakeStaging.mjs --prune    (npm run clean:staging)
 *   node scripts/cmakeStaging.mjs --verify   (npm run verify:staging)
 *   node scripts/cmakeStaging.mjs --prune --dry-run
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** AGP writes one of these per module, per variant, per ABI, once CMake configures. */
const METADATA_FILENAME = 'metadata_generation_command.txt';

/** The flag whose arrival this script exists to prove. Mirrors the plugin's constant. */
export const REQUIRED_CMAKE_ARGUMENT = '-DCMAKE_OBJECT_PATH_MAX=259';

/**
 * Staging root when KANGENTIC_CMAKE_STAGING_ROOT is unset.
 *
 * Mirrors `defaultStagingRoot` in plugins/withAndroidCmakeBuildStaging.ts, and
 * tests/unit/androidCmakeBuildStaging.test.ts imports both and asserts they
 * agree, because a drift here would make the prune walk an empty directory and
 * report success having looked at nothing.
 */
export function defaultStagingRoot(systemDrive) {
  return `${systemDrive || 'C:'}/kangentic/android`;
}

export function resolveStagingRoot(environment = process.env) {
  return environment.KANGENTIC_CMAKE_STAGING_ROOT || defaultStagingRoot(environment.SystemDrive);
}

/** Every `metadata_generation_command.txt` beneath `directory`. */
export function findMetadataFiles(directory) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...findMetadataFiles(full));
    } else if (entry.name === METADATA_FILENAME) {
      found.push(full);
    }
  }
  return found;
}

/** Reads a file, or null when it vanished between the directory walk and here. */
function readTextOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The checkout a staging tree belongs to, or null when it cannot be determined.
 *
 * AGP already records the source path in the metadata file, so no marker file
 * of our own is needed. Note it records `<checkout>/android`, which is a
 * GITIGNORED PREBUILD ARTIFACT: `expo prebuild --clean` and any `android/` wipe
 * remove it while the checkout is perfectly alive. Returning the parent is what
 * makes `isOrphaned` check something durable.
 *
 * ONLY THE `app` MODULE RECORDS THIS. Library modules configure through their
 * own CMakeLists and their metadata carries no `-DPROJECT_ROOT_DIR` at all, so
 * callers must scan every metadata file rather than trusting the first.
 */
export function readCheckoutPath(metadataContents) {
  const match = /^-DPROJECT_ROOT_DIR=(.+)$/m.exec(metadataContents);
  if (!match) {
    return null;
  }
  return dirname(match[1].trim());
}

/**
 * Whether a staging tree's checkout is gone.
 *
 * Checks `package.json` rather than the recorded `android/` path, per above.
 * Returns null for "cannot tell", which the caller must treat as keep. A build
 * that failed before CMake configured leaves the directory with no metadata
 * file at all, and deleting on absence is the dangerous default a
 * find-first-match loop falls into.
 */
export function classifyStagingTree(treeDirectory) {
  const metadataFiles = findMetadataFiles(treeDirectory);
  if (metadataFiles.length === 0) {
    return { status: 'unknown', reason: `no ${METADATA_FILENAME} anywhere beneath it` };
  }

  // EVERY metadata file, not just the first. Only the `app` module's invocation
  // carries -DPROJECT_ROOT_DIR (see readCheckoutPath), so reading
  // `metadataFiles[0]` worked purely because `app` happens to sort first in
  // directory order. A module named ahead of it, or a build that failed before
  // `:app` configured, turned the whole prune into a permanent no-op that
  // reported "skip" forever and reclaimed nothing.
  for (const metadataFile of metadataFiles) {
    const contents = readTextOrNull(metadataFile);
    if (contents === null) {
      continue;
    }
    const checkoutPath = readCheckoutPath(contents);
    if (!checkoutPath) {
      continue;
    }
    return existsSync(join(checkoutPath, 'package.json'))
      ? { status: 'live', checkoutPath }
      : { status: 'orphaned', checkoutPath };
  }

  return {
    status: 'unknown',
    reason: `no ${METADATA_FILENAME} beneath it carries -DPROJECT_ROOT_DIR`,
  };
}

/**
 * Whether two paths name the same checkout.
 *
 * Case-insensitive because the two sides come from different places: AGP's
 * recorded `-DPROJECT_ROOT_DIR` against `process.cwd()`, on a filesystem that
 * does not care about case.
 */
function isSameCheckout(left, right) {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function stagingTrees(stagingRoot) {
  try {
    return readdirSync(stagingRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(stagingRoot, entry.name));
  } catch {
    return [];
  }
}

function directorySize(directory) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    // Same reason as the statSync guard below, and it matters more here: this
    // runs immediately before rmSync, so a subdirectory that vanishes mid-walk
    // must not crash the prune partway through its list of trees.
    return total;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      total += directorySize(full);
    } else {
      try {
        total += statSync(full).size;
      } catch {
        // A file that vanished mid-walk is not worth failing a size report over.
      }
    }
  }
  return total;
}

function formatMegabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function prune({ dryRun }) {
  const stagingRoot = resolveStagingRoot();
  const trees = stagingTrees(stagingRoot);

  if (trees.length === 0) {
    console.log(`Nothing to prune: ${stagingRoot} holds no staging trees.`);
    return 0;
  }

  let reclaimed = 0;
  let removed = 0;
  for (const tree of trees) {
    const verdict = classifyStagingTree(tree);
    if (verdict.status === 'live') {
      console.log(`keep    ${tree}  (${verdict.checkoutPath})`);
      continue;
    }
    if (verdict.status === 'unknown') {
      console.log(`skip    ${tree}  (${verdict.reason})`);
      continue;
    }

    const size = directorySize(tree);
    reclaimed += size;
    removed += 1;
    if (dryRun) {
      console.log(`would remove ${tree}  (${verdict.checkoutPath} is gone, ${formatMegabytes(size)})`);
      continue;
    }
    rmSync(tree, { recursive: true, force: true });
    console.log(`removed ${tree}  (${verdict.checkoutPath} is gone, ${formatMegabytes(size)})`);
  }

  const verb = dryRun ? 'would reclaim' : 'reclaimed';
  console.log(`\n${removed} of ${trees.length} tree(s) orphaned, ${verb} ${formatMegabytes(reclaimed)}.`);
  return 0;
}

export function verify(checkoutPath = process.cwd()) {
  const stagingRoot = resolveStagingRoot();

  // SCOPED TO THIS CHECKOUT, not the whole root. The root is shared by every
  // worktree on the machine, and trees survive `gradlew clean` by design, so a
  // sibling branch last built before this flag existed would otherwise fail the
  // verification of a build that is perfectly correct - naming a file that has
  // nothing to do with it. Prune that tree, or rebuild it; do not widen this.
  const ourTrees = stagingTrees(stagingRoot).filter((tree) => {
    const verdict = classifyStagingTree(tree);
    return verdict.status !== 'unknown' && isSameCheckout(verdict.checkoutPath, checkoutPath);
  });

  const readable = ourTrees
    .flatMap(findMetadataFiles)
    .map((file) => ({ file, contents: readTextOrNull(file) }))
    .filter((entry) => entry.contents !== null);

  // Non-vacuity guard. A scan that silently matches nothing and reports success
  // is worse than no scan: it reads as proof the flag arrived.
  if (readable.length === 0) {
    console.error(`FAIL: no ${METADATA_FILENAME} under ${stagingRoot} belongs to ${checkoutPath}.`);
    console.error('');
    console.error('Either no Android build has run in THIS checkout since the staging');
    console.error('relocation landed, or the block never reached settings.gradle. Run a');
    console.error('build first; if one just succeeded, the plugin did not apply.');
    return 1;
  }

  const missing = readable
    .filter((entry) => !entry.contents.includes(REQUIRED_CMAKE_ARGUMENT))
    .map((entry) => entry.file);

  if (missing.length > 0) {
    console.error(`FAIL: ${missing.length} of ${readable.length} CMake invocations lack ${REQUIRED_CMAKE_ARGUMENT}:`);
    for (const file of missing.slice(0, 10)) {
      console.error(`  ${file}`);
    }
    if (missing.length > 10) {
      console.error(`  ... and ${missing.length - 10} more`);
    }
    return 1;
  }

  console.log(`OK: all ${readable.length} CMake invocations for ${checkoutPath} carry ${REQUIRED_CMAKE_ARGUMENT}.`);
  return 0;
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  if (argv.includes('--verify')) {
    return verify();
  }
  if (argv.includes('--prune')) {
    return prune({ dryRun });
  }
  console.error('Usage: node scripts/cmakeStaging.mjs --prune [--dry-run] | --verify');
  return 1;
}

// Importable for tests without running a command or exiting the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
