import * as Sentry from '@sentry/react-native';
import { isCrashReportingInitialized } from './crashReporting';
import {
  isConnectionBreadcrumbState,
  isLensScreenName,
  isScreenLens,
  isTrailSilentScreen,
  screenNameFromSegments,
  type ConnectionBreadcrumbState,
  type LensScreenName,
  type ScreenLens,
  type ScreenName,
} from './reportVocabulary';
import { CONNECTION_BREADCRUMB_CATEGORY, NAVIGATION_BREADCRUMB_CATEGORY } from './scrubEvent';

/**
 * Where the app was and what it was doing, kept on the Sentry scope so that
 * every event carries it, native ones included.
 *
 * WHY THIS EXISTS. Sentry MOBILE-H was an iOS app hang whose event could not
 * be acted on: it did not say which screen was showing, it did not say whether
 * the app was reconnecting or a board had just landed, and its trail was all
 * sentry-cocoa's own battery and clock crumbs. MOBILE-8 had the same gap
 * before it. The maintainer's rule (2026-11-18) is that an issue we cannot fix
 * for lack of information is a reporting bug, so the report is what changes.
 *
 * WHY TAGS AND BREADCRUMBS BOTH. They answer different questions and fail
 * differently. A TAG is the durable answer to "where": it is one value, it is
 * replaced rather than appended, and nothing can evict it. A breadcrumb trail
 * is the answer to "how did it get there and since when", and it is a ring of
 * `maxBreadcrumbs` entries that the native SDKs also write their own crumbs
 * into, so on a phone left alone for days the app's entries can be pushed out
 * while the tag still stands. MOBILE-H's hang came after two and a half days
 * suspended, which is exactly that case.
 *
 * HOW IT REACHES A NATIVE EVENT. A JavaScript `beforeSend` never sees a native
 * crash, an app hang or a watchdog termination, so this only works because
 * scope data is synced to the native SDK as it is set. Read from
 * @sentry/react-native 8.34.0, not assumed: `Sentry.init` patches the
 * ISOLATION and GLOBAL scopes only (dist/js/sdk.js, `enableSyncToNative`), and
 * the top-level `Sentry.setTag` and `Sentry.addBreadcrumb` used here write the
 * isolation scope. `Sentry.getCurrentScope().setTag(...)` would look
 * equivalent and stay in JavaScript, so do not "tidy" these calls onto the
 * current scope. A breadcrumb is synced only after `beforeBreadcrumb` admits
 * it, which is why both categories are on the allowlist in scrubEvent.ts.
 * On the native side, read from sentry-cocoa 9.33.0: an app hang has the
 * scope applied when it is detected, and a watchdog-termination event is built
 * on the next launch from tags and a breadcrumb trail persisted to disk as
 * they were set. A delivered native crash on each platform is the proof, and
 * docs/developer-guide.md records what each one carried.
 *
 * ONE LIMIT THAT FOLLOWS FROM THE BRIDGE, read from RNSentry.mm: on iOS the
 * native module's method queue is the MAIN queue, so a tag or breadcrumb
 * recorded here reaches the native scope through the same thread an app hang
 * blocks. A hang event therefore carries the state from when the hang began,
 * not anything recorded while it lasted. The ordering still works in the
 * report's favour: a store update queues its breadcrumb before React commits
 * the re-render that update causes, so a board snapshot that caused a hang is
 * already on the scope when the hang starts.
 *
 * NOTHING HERE IS CONTENT, and the callers cannot make it so. Every value is a
 * member of a closed set in reportVocabulary.ts and is checked against that
 * set HERE, at runtime, whatever the type system was told: a screen name is a
 * route template and never a path, so never one of the desktop's task IDs. No
 * capture call is added, so the "exactly two capture calls" invariant in
 * .claude/rules/crash-reporting-scope.md is untouched: a tag and a breadcrumb
 * are scope data riding an event that was already going to be sent.
 *
 * No `react-native` import, on purpose: this module is unit-tested in the
 * pure vitest tier with only the SDK mocked.
 */

const SCREEN_TAG = 'screen';
const LENS_TAG = 'lens';

let currentScreen: ScreenName = 'none';

/**
 * The lens each lens-owning screen is on, with the screen INSTANCE that
 * reported it.
 *
 * TWO REPORTERS, AND NO PROMISE ABOUT THEIR ORDER. The screen's name comes from
 * the root layout's tracker; the lens comes from the screen itself, on focus.
 * An earlier version of this module assumed the screen's focus effect ran
 * first (read out of React's effect ordering: a later sibling's effect runs
 * last). A delivered event disproved it: on the first device run (Android,
 * 2026-11-18) opening a task recorded `lens: none` and then `chat` 8 ms later,
 * the tracker first. A route's screen mounts after the navigation state that
 * names it has already changed. So nothing below depends on which arrives
 * first, and three rules make that true:
 *
 * 1. An entry belongs to the instance that set it, and only that instance can
 *    clear it. The same route can be on the stack twice (one task opened over
 *    another from a notification), and the old instance's blur may run after
 *    the new instance has reported. Without the owner check that blur would
 *    wipe the new screen's lens.
 * 2. A lens is cleared when its instance blurs, so a lens can never be left
 *    over from an earlier visit and shown against a different task.
 * 3. Arriving on a lens-owning screen whose lens is not known yet moves the
 *    TAGS at once and HOLDS the breadcrumb until the lens arrives (see
 *    `crumbHeld`), so the trail gets one entry per arrival carrying the real
 *    pair, whichever reporter spoke first.
 */
const lensByScreen = new Map<LensScreenName, { lens: ScreenLens; owner: string }>();

/** What the scope holds now, so an unchanged pair costs nothing and records nothing. */
let reportedScreen: ScreenName | null = null;
let reportedLens: ScreenLens | null = null;

/**
 * True between arriving on a lens-owning screen and learning its lens. The
 * tags already say where the app is; only the breadcrumb is waiting. It is
 * released by the lens arriving, or by the app moving on first, never by a
 * timer: a breadcrumb waiting on a clock is one a crash can beat.
 */
let crumbHeld = false;

function effectiveLens(): ScreenLens {
  // `none`, never an absent tag: the native bridge stringifies whatever it is
  // handed, so clearing a tag with `undefined` would arrive as the text
  // "undefined" on a native event.
  return isLensScreenName(currentScreen) ? (lensByScreen.get(currentScreen)?.lens ?? 'none') : 'none';
}

function writeScreenTags(screen: ScreenName, lens: ScreenLens): void {
  Sentry.setTag(SCREEN_TAG, screen);
  Sentry.setTag(LENS_TAG, lens);
}

function recordScreenBreadcrumb(screen: ScreenName, lens: ScreenLens): void {
  // The pairing screens set the tag (written by the caller) and stay off the
  // trail: when a pairing was attempted is not something a report records.
  if (isTrailSilentScreen(screen)) return;
  Sentry.addBreadcrumb({
    category: NAVIGATION_BREADCRUMB_CATEGORY,
    level: 'info',
    // The same two closed-set values as `data`, joined, because the Sentry
    // CLI's trail view prints only this column: without it every row of the
    // app's own trail read as blank on the first delivered event.
    message: lens === 'none' ? screen : `${screen} ${lens}`,
    // The pair and nothing else. No route params, no previous screen (the
    // crumb before this one is that), no free text.
    data: { screen, lens },
  });
}

/** Brings the scope up to date with the current screen and lens: tags, and one breadcrumb. */
function applyScreenContext(): void {
  const lens = effectiveLens();
  if (!crumbHeld && currentScreen === reportedScreen && lens === reportedLens) return;
  crumbHeld = false;
  reportedScreen = currentScreen;
  reportedLens = lens;
  try {
    writeScreenTags(currentScreen, lens);
    recordScreenBreadcrumb(currentScreen, lens);
  } catch {
    // Recording where the app is must never be the thing that breaks it.
  }
}

/**
 * Puts the starting values on the scope. Called from `index.js` at bundle
 * entry, immediately after `initializeCrashReporting()`.
 *
 * Outside React and this early so that an event from before the first render
 * says so: `screen: none` on a crash means no navigator had mounted, which is
 * the whole of a headless launch (a push waking a killed app) and the start of
 * every other one. Without it such an event would carry no `screen` tag at
 * all, which reads the same as an event from a build that predates the tag.
 *
 * Tags only, no breadcrumb: nothing has happened yet for a trail to record.
 */
export function initializeReportContext(): void {
  if (!isCrashReportingInitialized()) return;
  reportedScreen = currentScreen;
  reportedLens = effectiveLens();
  try {
    writeScreenTags(reportedScreen, reportedLens);
  } catch {
    // See applyScreenContext.
  }
}

/**
 * Reports the screen now showing, from expo-router's `useSegments()`.
 *
 * Takes the segments rather than a name so that the template is derived, and
 * checked against the closed set, on this side of the door. A caller cannot
 * hand over a resolved path and have it believed.
 */
export function setReportedScreen(segments: readonly string[]): void {
  if (!isCrashReportingInitialized()) return;
  const nextScreen = screenNameFromSegments(segments);
  // The same screen again: a change of route params (another task on the same
  // route) or a re-render. Nothing a report may carry has changed.
  if (nextScreen === currentScreen) return;

  if (crumbHeld) {
    // Leaving a lens-owning screen that never said which lens it was on. Its
    // arrival still belongs on the trail, so it is recorded now, as it stood.
    crumbHeld = false;
    try {
      recordScreenBreadcrumb(currentScreen, 'none');
    } catch {
      // See applyScreenContext.
    }
  }

  currentScreen = nextScreen;
  if (isLensScreenName(nextScreen) && !lensByScreen.has(nextScreen)) {
    // Arrived before the screen reported its lens, which is the usual order on
    // a fresh mount. Say where the app is NOW, on the tags, and hold the
    // breadcrumb for the lens.
    crumbHeld = true;
    reportedScreen = nextScreen;
    reportedLens = 'none';
    try {
      writeScreenTags(nextScreen, 'none');
    } catch {
      // See applyScreenContext.
    }
    return;
  }
  applyScreenContext();
}

/**
 * Reports the lens a lens-owning screen is on.
 *
 * `owner` identifies the reporting screen INSTANCE (a `useId()` value), so
 * that `clearReportedLens` from one instance cannot remove a lens another
 * instance of the same route has since reported. The lens takes effect only
 * while its screen is the one showing.
 */
export function setReportedLens(screen: LensScreenName, lens: Exclude<ScreenLens, 'none'>, owner: string): void {
  if (!isCrashReportingInitialized()) return;
  if (!isLensScreenName(screen) || !isScreenLens(lens)) return;
  lensByScreen.set(screen, { lens, owner });
  if (screen !== currentScreen) return;
  applyScreenContext();
}

/**
 * Forgets a lens when the instance that reported it blurs or unmounts, so it
 * cannot outlive the visit and be shown against a different task later.
 *
 * It only forgets. It writes no tag and records no breadcrumb, because a blur
 * is not a place: the screen that takes over reports itself, and until it does
 * the scope still describes the last place the app actually was. Recording
 * here would put a false "same screen, no lens" entry on the trail on every
 * exit.
 */
export function clearReportedLens(screen: LensScreenName, owner: string): void {
  if (!isCrashReportingInitialized()) return;
  if (lensByScreen.get(screen)?.owner === owner) lensByScreen.delete(screen);
}

/**
 * Records one step of the connection's life on the trail.
 *
 * The state is checked against the closed union at runtime because the
 * contract is about what LEAVES, and a type annotation does not survive a
 * cast: whatever reaches this function, the breadcrumb carries a member of
 * `ConnectionBreadcrumbState` or it is not recorded. No relay address, no
 * project, no count of anything the desktop sent.
 *
 * Which transitions are worth a slot, and how often, is decided by the caller
 * (`src/state/connectionBreadcrumbs.ts`), which is the side that can see the
 * stores. This side only decides what a recorded one may contain.
 */
export function recordConnectionState(state: ConnectionBreadcrumbState): void {
  if (!isCrashReportingInitialized()) return;
  if (!isConnectionBreadcrumbState(state)) return;
  try {
    Sentry.addBreadcrumb({
      category: CONNECTION_BREADCRUMB_CATEGORY,
      level: 'info',
      // The state again, for the CLI's trail view (see recordScreenBreadcrumb).
      message: state,
      data: { state },
    });
  } catch {
    // See applyScreenContext.
  }
}
