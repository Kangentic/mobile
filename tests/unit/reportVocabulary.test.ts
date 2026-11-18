/**
 * The closed sets a crash report's app-added fields are drawn from
 * (task #152, from Sentry MOBILE-H).
 *
 * The claim the privacy policy makes is that a report names the screen that
 * was open and never which task it showed. That holds only if the screen name
 * is the route TEMPLATE, and only for as long as every route has an entry, so
 * both are pinned here: the first by handing the function a resolved path's
 * parts, the second by walking `app/`.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONNECTION_BREADCRUMB_STATE_LIST,
  ROUTE_SCREEN_NAME_LIST,
  isConnectionBreadcrumbState,
  isLensScreenName,
  isScreenLens,
  isTrailSilentScreen,
  screenNameFromSegments,
} from '@/observability/reportVocabulary';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const appDirectoryPath = `${repositoryRoot}app`;

/**
 * The segments expo-router's `useSegments()` reports for every route file
 * under `app/`: the file's path split on `/`, with the extension gone and a
 * trailing `index` popped (expo-router's getRouteInfoFromState does the same).
 * Group directories are KEPT, as `useSegments()` keeps them; dropping them is
 * the function under test's job.
 *
 * Walked off the filesystem so the set cannot go stale the way a hardcoded
 * list would. `_layout.tsx` files are layouts, and `+native-intent` is
 * expo-router's deep-link redirect hook, so neither is ever a screen.
 */
function listRouteSegments(directoryPath: string, parentSegments: readonly string[] = []): string[][] {
  const routeSegments: string[][] = [];
  for (const directoryEntry of readdirSync(directoryPath, { withFileTypes: true })) {
    if (directoryEntry.isDirectory()) {
      routeSegments.push(
        ...listRouteSegments(`${directoryPath}/${directoryEntry.name}`, [...parentSegments, directoryEntry.name]),
      );
      continue;
    }
    if (!/\.tsx?$/.test(directoryEntry.name)) continue;
    if (directoryEntry.name === '_layout.tsx') continue;
    if (/^\+native-intent\.tsx?$/.test(directoryEntry.name)) continue;
    const fileSegment = directoryEntry.name.replace(/\.tsx?$/, '');
    routeSegments.push(fileSegment === 'index' ? [...parentSegments] : [...parentSegments, fileSegment]);
  }
  return routeSegments;
}

describe('screenNameFromSegments', () => {
  it("reads a task's session as its template, whichever task is open", () => {
    expect(screenNameFromSegments(['task', '[taskId]'])).toBe('/task/[taskId]');
    expect(screenNameFromSegments(['task', '[taskId]', 'changes'])).toBe('/task/[taskId]/changes');
  });

  it('answers unknown for a resolved path, so a task id can never become the screen name', () => {
    // What a caller would pass if it read `usePathname()` instead of
    // `useSegments()`: the parameter substituted. The id is not a member of the
    // closed set, so nothing derived from it survives.
    const resolved = screenNameFromSegments(['task', 'a81f0c2e-7d14-4c9b-9f6e-2b5d3c1a0e77']);
    expect(resolved).toBe('unknown');
    expect(screenNameFromSegments(['task', 'a81f0c2e-7d14-4c9b-9f6e-2b5d3c1a0e77', 'changes'])).toBe('unknown');
  });

  it('drops route groups, the way expo-router drops them from a URL', () => {
    expect(screenNameFromSegments(['(tabs)'])).toBe('/');
    expect(screenNameFromSegments(['(tabs)', 'board'])).toBe('/board');
  });

  it('reads the not-found route under its own name', () => {
    expect(screenNameFromSegments(['+not-found'])).toBe('/+not-found');
  });

  it('answers unknown for a route that has no entry', () => {
    expect(screenNameFromSegments(['some-future-screen'])).toBe('unknown');
    expect(screenNameFromSegments(['settings', 'extra'])).toBe('unknown');
  });

  it('is not fooled by a property every object inherits', () => {
    // The record is looked up with hasOwnProperty, not `in`, for this case.
    expect(screenNameFromSegments(['constructor'])).toBe('unknown');
    expect(screenNameFromSegments(['toString'])).toBe('unknown');
  });
});

describe('the screen-name record against the route files under app/', () => {
  const routeSegmentLists = listRouteSegments(appDirectoryPath);

  it('finds route files to compare, so a broken walk cannot pass vacuously', () => {
    expect(routeSegmentLists.length).toBeGreaterThan(15);
    expect(routeSegmentLists).toContainEqual(['task', '[taskId]']);
    expect(routeSegmentLists).toContainEqual(['(tabs)']);
  });

  it('has a name for every route file, so no screen ships reporting as unknown', () => {
    const unnamedRoutes = routeSegmentLists
      .filter((segments) => screenNameFromSegments(segments) === 'unknown')
      .map((segments) => segments.join('/'));
    expect(unnamedRoutes).toEqual([]);
  });

  it('has no name left over for a route file that no longer exists', () => {
    const namesFromFiles = new Set(routeSegmentLists.map((segments) => screenNameFromSegments(segments)));
    const namesWithoutFile = ROUTE_SCREEN_NAME_LIST.filter((screenName) => !namesFromFiles.has(screenName));
    expect(namesWithoutFile).toEqual([]);
  });
});

describe('the screens kept off the trail', () => {
  it('is exactly the two steps of the pairing ceremony', () => {
    // Listed against every route, so a new screen cannot join or leave the
    // silent set without this test saying so.
    const silent = ROUTE_SCREEN_NAME_LIST.filter((screenName) => isTrailSilentScreen(screenName));
    expect([...silent].sort()).toEqual(['/pair', '/pair-confirm']);
  });

  it('does not silence the screens around pairing, or the placeholder names', () => {
    expect(isTrailSilentScreen('/devices')).toBe(false);
    expect(isTrailSilentScreen('/settings')).toBe(false);
    expect(isTrailSilentScreen('none')).toBe(false);
    expect(isTrailSilentScreen('unknown')).toBe(false);
  });
});

describe('the lens and connection sets', () => {
  it('accepts the lenses the three lens screens can show, and none', () => {
    for (const lens of ['none', 'terminal', 'chat', 'changes', 'conversation', 'summary', 'description']) {
      expect(isScreenLens(lens)).toBe(true);
    }
  });

  it('rejects anything else as a lens', () => {
    expect(isScreenLens('reading-view')).toBe(false);
    expect(isScreenLens('')).toBe(false);
    expect(isScreenLens(undefined)).toBe(false);
    expect(isScreenLens('constructor')).toBe(false);
  });

  it('names exactly the three screens that own a lens', () => {
    expect(isLensScreenName('/task/[taskId]')).toBe(true);
    expect(isLensScreenName('/command-terminal')).toBe(true);
    expect(isLensScreenName('/completed-task')).toBe(true);
    expect(isLensScreenName('/settings')).toBe(false);
    expect(isLensScreenName('/task/[taskId]/changes')).toBe(false);
  });

  it('is not fooled by a property every object inherits, in the lens-screen, silent-screen and connection sets', () => {
    // The mutation this guards: `candidate in record` instead of an own-key
    // check in isOwnKey, which makes `constructor` and `toString` members.
    for (const inheritedName of ['constructor', 'toString']) {
      expect(isLensScreenName(inheritedName)).toBe(false);
      expect(isConnectionBreadcrumbState(inheritedName)).toBe(false);
      expect(isTrailSilentScreen(inheritedName as never)).toBe(false);
    }
  });

  it('holds the connection states to the six the trail records', () => {
    expect([...CONNECTION_BREADCRUMB_STATE_LIST].sort()).toEqual(
      ['board-snapshot', 'closed', 'connected', 'connecting', 'established', 'reconnecting'].sort(),
    );
  });

  it('rejects a transport state the trail does not record, and free text', () => {
    // `idle` is a protocol TransportState with no member here: the trail
    // records leaving a live state as `closed`, never the rest state itself.
    expect(isConnectionBreadcrumbState('idle')).toBe(false);
    expect(isConnectionBreadcrumbState('rekey')).toBe(false);
    expect(isConnectionBreadcrumbState('wss://relay.example/slot/abc')).toBe(false);
    expect(isConnectionBreadcrumbState(3)).toBe(false);
  });
});
