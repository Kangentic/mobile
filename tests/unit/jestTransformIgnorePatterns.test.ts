/**
 * jest.config.js restates jest-expo's `transformIgnorePatterns` with two
 * additions, because Jest REPLACES that key rather than merging it with the
 * preset's: @shopify/flash-list 2.3 ships ES modules only, and Sentry's 10.x
 * JavaScript packages resolve to `build/esm`, so neither parses untransformed.
 *
 * A restated copy drifts silently. When a future jest-expo changes its own list
 * (the SDK 58 upgrade will), the copy here keeps overriding it, and the first
 * symptom is a suite that fails to parse for a reason nobody connects to this
 * file. This pins the copy to the INSTALLED preset, so that drift fails here
 * with a message that names the cause.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

interface JestProject {
  displayName: string;
  transformIgnorePatterns?: string[];
}

const jestConfig = createRequire(import.meta.url)(join(repositoryRoot, 'jest.config.js')) as {
  projects: JestProject[];
};

/** The string literals of jest-expo's own `jestPreset.transformIgnorePatterns = [...]` assignment. */
function installedPresetPatterns(): string[] {
  const presetSource = readFileSync(join(repositoryRoot, 'node_modules/jest-expo/jest-preset.js'), 'utf8');
  const assignment = presetSource.match(/jestPreset\.transformIgnorePatterns = \[([\s\S]*?)\];/);
  expect(assignment, 'jest-expo/jest-preset.js no longer assigns transformIgnorePatterns this way').not.toBeNull();
  // Comment lines first: the preset explains each entry in prose, and an
  // apostrophe in "it's part of the transformer" reads as a string delimiter.
  const code = (assignment?.[1] ?? '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  return [...code.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe('jest.config.js transformIgnorePatterns', () => {
  it('reads three patterns from the installed jest-expo preset (guards the comparison below)', () => {
    expect(installedPresetPatterns()).toHaveLength(3);
  });

  it.each(jestConfig.projects.map((project) => [project.displayName, project] as const))(
    "is jest-expo's list with only @sentry widened and @shopify/flash-list added (%s)",
    (_displayName, project) => {
      const [allowlist, ...rest] = installedPresetPatterns();
      const expectedAllowlist = allowlist.replace('|@sentry/react-native|', '|@sentry|@shopify/flash-list|');
      expect(expectedAllowlist, 'the preset allowlist no longer contains @sentry/react-native').not.toBe(allowlist);
      expect(project.transformIgnorePatterns).toEqual([expectedAllowlist, ...rest]);
    },
  );
});
