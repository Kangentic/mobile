/**
 * app/_layout.tsx's wiring for two invariants documented in
 * .claude/rules/imperative-router-inside-react.md and
 * src/navigation/pendingNavigation.ts, neither of which any existing test
 * touches at the one file where the wiring actually happens:
 *
 * - `<PendingNavigationRunner />` must render as a SIBLING of the root
 *   `<Stack>`, immediately AFTER it. Its correctness comes from tree
 *   position, not a runtime check (see the comment in
 *   PendingNavigationRunner.tsx): a navigator mounted BEFORE this
 *   component's effect runs is what makes calling the router here safe.
 *   Every existing test that exercises PendingNavigationRunner renders the
 *   component directly (tests/components/PendingNavigationRunner.test.tsx),
 *   so none of them can catch app/_layout.tsx itself regressing this - a
 *   layout that stopped rendering the runner at all, or moved it inside
 *   `<Stack>`, would leave every one of those tests green.
 * - `app/_layout.tsx` must export `AppErrorBoundaryScreen` as `ErrorBoundary`,
 *   which is how expo-router wraps the whole route tree in it (`<Try
 *   catch={ErrorBoundary}>`). Deleting that export line leaves
 *   tests/components/AppErrorBoundaryScreen.test.tsx green - it renders the
 *   component directly - while the shipped app installs no boundary at all.
 * - The root effect must run the settings hydrate THROUGH `runWhenFirstActive`
 *   and return its cancel. In an iOS background launch (a sealed clear can
 *   launch the app with the phone locked) the settings' WHEN_UNLOCKED Keychain
 *   reads throw, and `hydrate()` turns each failure into its default: the next
 *   connection would register the default push categories with the desktop and
 *   the next toggle would persist defaults over the user's choices (see
 *   src/lib/whenFirstActive.ts). tests/unit/whenFirstActive.test.ts covers
 *   `runWhenFirstActive` itself, but reverting the layout to an immediate
 *   `void useSettingsStore.getState().hydrate()` leaves that test green.
 *
 * A source scan, not a render: standing up the real root layout needs a full
 * expo-router navigator tree, which this suite deliberately does not do (see
 * PendingNavigationRunner.test.tsx's note that the cold-start crash itself is
 * not reproducible under jest).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const rootLayoutSource = readFileSync(`${repositoryRoot}app/_layout.tsx`, 'utf8');

/**
 * Strips block comments, JSX-wrapped (`{/* ... *\/}`) or plain
 * (`/* ... *\/`), before any positional check below. The comment sitting
 * directly above `<PendingNavigationRunner />` explains this very invariant
 * in prose and contains the literal text `<Stack>` three times - so an
 * un-stripped `indexOf` could be satisfied or defeated by the comment rather
 * than the code. Same approach as tests/unit/routeTitles.test.ts, which
 * documents being bitten by this class of bug in both directions.
 */
function stripBlockComments(source: string): string {
  return source.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');
}

const strippedSource = stripBlockComments(rootLayoutSource);

/**
 * Block comments AND whole-line `//` comments gone, for the checks that match
 * identifiers in the root effect. The `//` comment above the deferred hydrate
 * names `runWhenFirstActive` in prose ("See runWhenFirstActive."), so a loose
 * `toContain('runWhenFirstActive')` on the raw text would stay green after the
 * code stopped calling it. Same whole-line approach as `withoutComments` in
 * tests/unit/nsePayloadShapeParity.test.ts; a trailing comment on a code line
 * is NOT stripped, so keep any future note on its own line.
 */
function stripCommentsForCode(source: string): string {
  return stripBlockComments(source)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * The text between the parenthesis at `openParenthesisIndex` and its matching
 * close, so "inside the call's callback" is a fact about the nesting rather
 * than about how far apart two indexes happen to be. Counts only `(` and `)`,
 * which is enough for the root effect's callback (no parenthesis in a string
 * or regex literal there); the `closed` assertion in the caller fails loudly
 * if that ever stops being true.
 */
function callArguments(
  source: string,
  openParenthesisIndex: number,
): { text: string; closed: boolean } {
  let depth = 0;
  for (let index = openParenthesisIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return { text: source.slice(openParenthesisIndex + 1, index), closed: true };
      }
    }
  }
  return { text: source.slice(openParenthesisIndex + 1), closed: false };
}

const rootLayoutCode = stripCommentsForCode(rootLayoutSource);

describe('app/_layout.tsx wiring', () => {
  it('is non-trivial and still contains the root Stack (vacuity guard on the comment strip)', () => {
    // If the strip regex ever over-matched (a stray `/*` in a string, say)
    // it could eat the whole file and every assertion below would pass
    // having checked nothing.
    expect(strippedSource.length).toBeGreaterThan(1000);
    expect(strippedSource).toContain('<Stack');
  });

  it('exports AppErrorBoundaryScreen as ErrorBoundary, which is how expo-router installs the app-wide boundary', () => {
    expect(strippedSource).toMatch(/export\s*\{\s*AppErrorBoundaryScreen\s+as\s+ErrorBoundary\s*\}/);
  });

  it('renders PendingNavigationRunner exactly once', () => {
    const occurrences = strippedSource.match(/<PendingNavigationRunner\b/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('renders PendingNavigationRunner as a sibling AFTER the root Stack closes, never inside or before it', () => {
    const stackCloseOccurrences = strippedSource.match(/<\/Stack>/g) ?? [];
    // Non-vacuity: a silent zero count here (the closing-tag text changing
    // shape) would make the position comparison below meaningless.
    expect(stackCloseOccurrences).toHaveLength(1);

    const stackCloseIndex = strippedSource.indexOf('</Stack>');
    const runnerIndex = strippedSource.indexOf('<PendingNavigationRunner');
    expect(stackCloseIndex).toBeGreaterThan(0);
    expect(runnerIndex).toBeGreaterThan(0);
    expect(runnerIndex).toBeGreaterThan(stackCloseIndex);
  });
});

describe('app/_layout.tsx defers the settings hydrate through runWhenFirstActive', () => {
  it('is non-trivial and has no whole-line // comment left (vacuity guard on the comment strip)', () => {
    // The `//` comment above the deferred hydrate names runWhenFirstActive in
    // prose; if the strip stopped removing it, the identifier checks below
    // could be satisfied by the comment while the code called nothing.
    expect(rootLayoutCode.length).toBeGreaterThan(1000);
    expect(rootLayoutCode).toContain('export default function RootLayout');
    expect(rootLayoutCode).not.toMatch(/^\s*\/\//m);
  });

  it("imports runWhenFirstActive from '@/lib/whenFirstActive'", () => {
    expect(rootLayoutCode).toMatch(
      /import\s*\{[^}]*\brunWhenFirstActive\b[^}]*\}\s*from\s*'@\/lib\/whenFirstActive'/,
    );
  });

  it('returns runWhenFirstActive(...) from the root effect, so an unmount cancels a deferred hydrate', () => {
    // `return`, not a bare call: the returned cancel is the effect's cleanup,
    // which removes the AppState listener of a deferred run on unmount.
    expect(rootLayoutCode).toMatch(/\breturn\s+runWhenFirstActive\(/);
  });

  it('calls hydrate() exactly once, and only inside the runWhenFirstActive callback', () => {
    // Exactly one hydrate in the whole layout: a second, immediate one beside
    // the deferred one would reintroduce the locked-phone read just the same.
    const hydrateCallsInLayout = rootLayoutCode.match(/\.hydrate\(\)/g) ?? [];
    expect(hydrateCallsInLayout).toHaveLength(1);

    const returnedCallIndex = rootLayoutCode.search(/\breturn\s+runWhenFirstActive\(/);
    // Non-vacuity: a -1 here would make indexOf('(', -1) scan from the file's
    // start and the nesting walk below would check the wrong call.
    expect(returnedCallIndex).toBeGreaterThan(-1);

    const openParenthesisIndex = rootLayoutCode.indexOf('(', returnedCallIndex);
    const callback = callArguments(rootLayoutCode, openParenthesisIndex);
    expect(callback.closed).toBe(true);

    const hydrateCallsInCallback = callback.text.match(/\.hydrate\(\)/g) ?? [];
    expect(hydrateCallsInCallback).toHaveLength(1);
  });
});
