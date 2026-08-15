/**
 * Guards the root stack against untitled route registrations.
 *
 * iOS derives the native back button's label from the PREVIOUS route's
 * `title`. A registration without one falls back to the literal route name,
 * which is how the back button read "(tabs)" on Settings and on the pairing
 * screen in a tester recording (2026-08-15), and "task/[taskId]/index" on the
 * file diff before FileDiffScreen papered over it. Android draws a bare
 * chevron and never shows the label, so only iOS testers catch it, months
 * late. This scan makes the mistake mechanical instead of tester-caught. It
 * also catches a route file with no registration at all, and a back-label
 * string that has drifted out of sync between a screen's own
 * `headerBackTitle` and the route title it borrows.
 *
 * Form-sheet routes are exempt: they render no native header and nothing is
 * pushed on top of a sheet, so their titles feed no back label.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const rootLayoutSource = readFileSync(`${repositoryRoot}app/_layout.tsx`, 'utf8');
const appDirectoryPath = `${repositoryRoot}app`;

interface RouteRegistration {
  name: string | null;
  source: string;
}

/**
 * Every `<Stack.Screen ... />` tag in the layout, with comments inside the
 * tag stripped so a comment mentioning `title:` or `formSheetOptions` cannot
 * satisfy the checks below (tests/unit/buildWorkflow.test.ts documents being
 * bitten by exactly that, in both directions). Assumes each registration is
 * one self-closing tag; the count test below pins that assumption, so a
 * reformat that breaks it fails loudly instead of silently dropping a
 * registration from the scan.
 */
function readRegistrations(): RouteRegistration[] {
  const registrations: RouteRegistration[] = [];
  for (const match of rootLayoutSource.matchAll(/<Stack\.Screen[\s\S]*?\/>/g)) {
    const sourceWithoutComments = match[0].replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');
    const nameMatch = sourceWithoutComments.match(/name=["']([^"']+)["']/);
    registrations.push({ name: nameMatch ? nameMatch[1] : null, source: sourceWithoutComments });
  }
  return registrations;
}

/**
 * Every route file under `app/`, mapped to the registration name it should
 * appear under - walked straight off the filesystem so this set cannot go
 * stale the way a hardcoded list would (that is exactly how
 * `app/+not-found.tsx` sat with no `<Stack.Screen>` at all before this
 * branch: nothing enumerated the files that exist, only the tags already
 * written).
 *
 * `_layout.tsx` files, at any depth, are layouts rather than routes and are
 * excluded. A file that lives directly under a group directory such as
 * `(tabs)` collapses to that group's own registration name, since those
 * routes belong to the nested navigator the group renders, not the root
 * stack. Everything else becomes its path relative to `app/`, forward
 * slashed, with the extension stripped.
 */
function deriveExpectedRouteNames(directoryPath: string, relativeRoutePath = ''): Set<string> {
  const expectedRouteNames = new Set<string>();
  for (const directoryEntry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryRelativePath =
      relativeRoutePath === '' ? directoryEntry.name : `${relativeRoutePath}/${directoryEntry.name}`;
    if (directoryEntry.isDirectory()) {
      const nestedRouteNames = deriveExpectedRouteNames(`${directoryPath}/${directoryEntry.name}`, entryRelativePath);
      for (const nestedRouteName of nestedRouteNames) {
        expectedRouteNames.add(nestedRouteName);
      }
      continue;
    }
    if (directoryEntry.name === '_layout.tsx') {
      continue;
    }
    const groupDirectoryMatch = entryRelativePath.match(/^(\([^)]+\))\//);
    if (groupDirectoryMatch) {
      expectedRouteNames.add(groupDirectoryMatch[1]);
      continue;
    }
    expectedRouteNames.add(entryRelativePath.replace(/\.tsx?$/, ''));
  }
  return expectedRouteNames;
}

describe('root stack route titles', () => {
  const registrations = readRegistrations();

  it('captures every registration in the layout (a parse miss silently shrinks coverage)', () => {
    const openingTagCount = rootLayoutSource.match(/<Stack\.Screen/g)?.length ?? 0;
    expect(openingTagCount).toBeGreaterThan(0);
    expect(registrations).toHaveLength(openingTagCount);
  });

  it('every registration declares a name', () => {
    const nameless = registrations.filter((registration) => registration.name === null);
    expect(nameless.map((registration) => registration.source)).toEqual([]);
  });

  it('parses the registrations the layout is known to contain', () => {
    const names = registrations.map((registration) => registration.name);
    expect(names).toContain('(tabs)');
    expect(names).toContain('settings');
    expect(names).toContain('pair');
    expect(names).toContain('create-task');
  });

  it('every non-sheet registration declares a non-empty title', () => {
    // A bare `/\btitle:/` presence check is satisfied by `title: ''`, which
    // renders the same empty back label this test exists to catch. Require a
    // quoted string with at least one character instead.
    const untitled = registrations
      .filter((registration) => !/options=\{formSheetOptions\}/.test(registration.source))
      .filter((registration) => !/\btitle:\s*['"][^'"]+['"]/.test(registration.source))
      .map((registration) => registration.name);
    expect(untitled).toEqual([]);
  });

  it('has a Stack.Screen registration for every route file under app/', () => {
    // Every check above only inspects registrations that already exist, so a
    // route file with no <Stack.Screen> tag at all is invisible to them - the
    // exact way app/+not-found.tsx sat unregistered until this branch. The
    // expected set is derived from the filesystem, not hardcoded, so it
    // cannot recreate that same blind spot one level up.
    const expectedRouteNames = deriveExpectedRouteNames(appDirectoryPath);
    const registeredRouteNames = new Set(registrations.map((registration) => registration.name));
    const missingRegistrations = [...expectedRouteNames].filter(
      (routeName) => !registeredRouteNames.has(routeName),
    );
    expect(missingRegistrations).toEqual([]);
  });

  it("FileDiffScreen's headerBackTitle stays in sync with the session route's title", () => {
    // FileDiffScreen hardcodes headerBackTitle: 'Session' because that is the
    // literal title app/_layout.tsx currently gives task/[taskId]/index -
    // nothing fails today if either string is renamed alone. Both values are
    // extracted from source here rather than hardcoded, so a coordinated
    // rename of both stays green and a lone rename of either one fails.
    const fileDiffScreenSource = readFileSync(`${repositoryRoot}src/screens/FileDiffScreen.tsx`, 'utf8');
    const headerBackTitleMatch = fileDiffScreenSource.match(/headerBackTitle:\s*['"]([^'"]+)['"]/);
    expect(headerBackTitleMatch).not.toBeNull();

    const sessionRegistration = registrations.find(
      (registration) => registration.name === 'task/[taskId]/index',
    );
    expect(sessionRegistration).toBeDefined();
    const sessionTitleMatch = sessionRegistration?.source.match(/\btitle:\s*['"]([^'"]+)['"]/);
    expect(sessionTitleMatch).not.toBeNull();

    expect(headerBackTitleMatch?.[1]).toEqual(sessionTitleMatch?.[1]);
  });
});
