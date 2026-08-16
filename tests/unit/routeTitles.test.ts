/**
 * Guards the root stack against untitled route registrations.
 *
 * iOS derives the native back button's borrowed title from the PREVIOUS
 * route's `title`. A registration without one falls back to the literal
 * route name, which is how the back button read "(tabs)" on Settings and on
 * the pairing screen in a tester recording (2026-08-15). Back buttons are
 * chevron-only now (`headerBackButtonDisplayMode: 'minimal'`, pinned below),
 * so the borrowed title feeds the long-press menu and the accessibility
 * label rather than a visible label - surfaces only iOS testers catch,
 * months late. This scan makes the mistake mechanical instead of
 * tester-caught. It also catches a route file with no registration at all,
 * and a screen reintroducing the pinned `headerBackTitle` that minimal mode
 * exists to replace.
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

/** Every .ts/.tsx file under a directory, recursively - the scan set for the pinned-back-label ban below. */
function listSourceFiles(directoryPath: string): string[] {
  const sourceFilePaths: string[] = [];
  for (const directoryEntry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = `${directoryPath}/${directoryEntry.name}`;
    if (directoryEntry.isDirectory()) {
      sourceFilePaths.push(...listSourceFiles(entryPath));
      continue;
    }
    if (/\.tsx?$/.test(directoryEntry.name)) {
      sourceFilePaths.push(entryPath);
    }
  }
  return sourceFilePaths;
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

  it("the root stack pins chevron-only back buttons (headerBackButtonDisplayMode 'minimal')", () => {
    // The predecessor of this test kept FileDiffScreen's pinned
    // headerBackTitle in sync with the session route's title. Minimal mode
    // replaced that design outright: no visible back label anywhere, so the
    // invariant flipped from "the pinned strings match" to "the mode is set
    // and no screen pins a label" (the next test). Match the option syntax
    // in the shared screenOptions block, before the first registration, so
    // a per-screen override cannot satisfy the check for the stack.
    const screenOptionsSource = rootLayoutSource.slice(0, rootLayoutSource.indexOf('<Stack.Screen'));
    expect(screenOptionsSource).toMatch(/headerBackButtonDisplayMode:\s*['"]minimal['"]/);
  });

  it('no screen reintroduces a pinned headerBackTitle', () => {
    // An explicit headerBackTitle is the one combination with an upstream
    // history of defeating minimal mode (react-native-screens #2809, fixed,
    // but not worth re-owning) - see FileDiffScreen's comment. Match the
    // OPTION (the key with a quoted string value), not the bare word, so
    // prose comments naming headerBackTitle stay legal.
    const offendingFilePaths = [...listSourceFiles(appDirectoryPath), ...listSourceFiles(`${repositoryRoot}src/screens`)]
      .filter((sourceFilePath) => /headerBackTitle:\s*['"]/.test(readFileSync(sourceFilePath, 'utf8')));
    expect(offendingFilePaths).toEqual([]);
  });
});
