/**
 * Every `expo.install.exclude` entry must carry a recorded reason, and every
 * recorded reason must still be an exclude.
 *
 * `npx expo install --check` is a required gate, and an exclude entry SILENCES
 * it for that package (.claude/rules/expo-cng.md). That is correct for a hold a
 * change deliberately vetted and dangerous for anything else: an entry that
 * outlives its reason masks every future drift of that package, which is how
 * the gesture-handler hold went unnoticed for weeks once already. The reasons
 * live in docs/developer-guide.md, "Dependencies held past the Expo SDK
 * mapping"; this ties that table to package.json in both directions.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

interface PackageManifest {
  expo?: { install?: { exclude?: string[] } };
}

const TABLE_HEADING = '#### Dependencies held past the Expo SDK mapping (`expo.install.exclude`)';

function excludedPackages(): string[] {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as PackageManifest;
  return [...(manifest.expo?.install?.exclude ?? [])].sort();
}

/**
 * First-column package names of the hold table: the FIRST markdown table after
 * the heading, and only that one. The guide has many tables, and the section
 * after this one opens with bold text rather than a heading, so a "read until
 * the next heading" slice sweeps unrelated tables in.
 */
function documentedHolds(): string[] {
  const guide = readFileSync(join(repositoryRoot, 'docs/developer-guide.md'), 'utf8');
  const headingIndex = guide.indexOf(TABLE_HEADING);
  expect(headingIndex, 'docs/developer-guide.md lost the hold table heading').toBeGreaterThan(-1);

  const holds: string[] = [];
  let insideTable = false;
  for (const line of guide.slice(headingIndex).split('\n')) {
    if (line.startsWith('|')) {
      insideTable = true;
      const match = line.match(/^\| `([^`]+)` \|/);
      if (match) holds.push(match[1]);
    } else if (insideTable) {
      break;
    }
  }
  return holds.sort();
}

describe('expo.install.exclude holds', () => {
  it('finds both lists at all (guards the comparison below against parsing nothing)', () => {
    expect(excludedPackages().length).toBeGreaterThan(0);
    expect(documentedHolds().length).toBeGreaterThan(0);
  });

  it('documents every excluded package, and excludes every documented one', () => {
    expect(documentedHolds()).toEqual(excludedPackages());
  });
});
