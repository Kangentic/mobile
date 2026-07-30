/**
 * Executes `.github/scripts/verify-android-assets.sh` against real archives.
 *
 * This guard is the only thing standing between a resource-shrunk `xterm.html`
 * and a fully green run, and its whole value rests on two properties that are
 * easy to break and invisible when broken: it must PASS on a correct artifact
 * whatever the resource got renamed to, and it must FAIL when the page is gone.
 * Asserting on the script's source text (as buildWorkflow.test.ts does) cannot
 * reach either one, so this runs the thing.
 *
 * Same approach as e2eGate.test.ts: extract nothing, stub nothing, run the real
 * script and read its exit code.
 *
 * Fixtures are written by a minimal STORED-entry zip writer below rather than a
 * library, because no zip writer is a direct dependency of this project and a
 * transitive one is not something a test should reach into. `unzip -l` reports
 * the uncompressed size for a stored entry exactly as it does for a deflated
 * one, which is the only field the script reads.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const guardScript = `${repositoryRoot}.github/scripts/verify-android-assets.sh`;
const terminalPageBytes = readFileSync(`${repositoryRoot}src/terminal/xterm.html`).length;

interface ZipEntry {
  name: string;
  contents: Buffer;
}

/** A ZIP archive with every entry STORED (method 0). */
function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.contents);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(entry.contents.length, 18); // compressed
    localHeader.writeUInt32LE(entry.contents.length, 22); // uncompressed
    localHeader.writeUInt16LE(nameBytes.length, 26);
    locals.push(localHeader, nameBytes, entry.contents);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(entry.contents.length, 20);
    centralHeader.writeUInt32LE(entry.contents.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centrals.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + entry.contents.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDirectory, endRecord]);
}

const scratch = mkdtempSync(join(tmpdir(), 'verify-android-assets-'));

function artifactContaining(entries: ZipEntry[], fixtureName: string): string {
  const path = join(scratch, fixtureName);
  writeFileSync(path, buildZip(entries));
  return path;
}

/** Exit code of the guard against one artifact. */
function runGuard(artifactPath: string): number {
  try {
    execFileSync('bash', [guardScript, artifactPath], { encoding: 'utf8' });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

/**
 * vitest's default per-test timeout is 5s, which is not enough headroom here.
 *
 * Every case below spawns real `bash` (and `unzip` inside it), and a process
 * spawn on Windows costs orders of magnitude more than on the Linux CI runner.
 * In isolation this file runs in under two seconds; inside a full
 * `vitest run tests/unit` it took 16s and tipped a case over the default, which
 * reads as "the guard is broken" rather than "the test was not given time to
 * spawn a shell". Same reasoning, and the same number, as
 * e2eChangesClassifier.test.ts's BASH_SPAWN_TIMEOUT_MS.
 */
const BASH_SPAWN_TIMEOUT_MS = 30_000;

const terminalPage: ZipEntry = {
  // The name a release APK actually ships, which is NOT res/raw/xterm.html.
  name: 'res/JU.html',
  contents: Buffer.alloc(terminalPageBytes, 0x61),
};
const unrelatedResource: ZipEntry = {
  name: 'res/values.xml',
  contents: Buffer.from('<resources/>', 'utf8'),
};

describe('verify-android-assets.sh', () => {
  it('passes when the page survives under an obfuscated resource name', () => {
    // The whole design point. `optimizeReleaseResources` renames resource files,
    // so matching on the path would fail a CORRECT build - measured on run
    // 30506459459, where the shipped entry was `res/JU.html`.
    expect(runGuard(artifactContaining([unrelatedResource, terminalPage], 'good.apk'))).toBe(0);
  }, BASH_SPAWN_TIMEOUT_MS);

  it('passes for the AAB layout, which does not rename', () => {
    // Play re-runs resource optimization at split time, so the bundle still
    // carries Metro's mangled name. One size has to match both layouts.
    const aabEntry: ZipEntry = { ...terminalPage, name: 'base/res/raw/src_terminal_xterm.html' };
    expect(runGuard(artifactContaining([unrelatedResource, aabEntry], 'good.aab'))).toBe(0);
  }, BASH_SPAWN_TIMEOUT_MS);

  it('fails when the page was shrunk away entirely', () => {
    expect(runGuard(artifactContaining([unrelatedResource], 'no-html.apk'))).toBe(1);
  }, BASH_SPAWN_TIMEOUT_MS);

  it('fails when an html survives but it is not the terminal page', () => {
    const decoy: ZipEntry = { name: 'res/AA.html', contents: Buffer.from('<!DOCTYPE html>', 'utf8') };
    expect(runGuard(artifactContaining([decoy], 'wrong-html.apk'))).toBe(1);
  }, BASH_SPAWN_TIMEOUT_MS);

  it('fails rather than passing vacuously when the artifact is missing', () => {
    expect(runGuard(join(scratch, 'does-not-exist.apk'))).toBe(1);
  }, BASH_SPAWN_TIMEOUT_MS);

  it('does not decide the match by piping into grep', () => {
    // verify-android-signature.sh's header records `printf | grep -q` failing a
    // correctly signed production AAB TWICE: grep -q exits on first match, the
    // writer takes SIGPIPE, and `set -o pipefail` reports 141 on a real match.
    // The cases above cannot catch it - the fixtures are small enough that the
    // write finishes first, which is exactly why it reached production there.
    const code = readFileSync(guardScript, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/\|\s*grep\s+-[a-zA-Z]*q/);
  }, BASH_SPAWN_TIMEOUT_MS);
});
