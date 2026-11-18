import * as Sentry from '@sentry/react-native';
import { isCrashReportingInitialized } from './crashReporting';
import {
  isConnectionBreadcrumbState,
  isLensScreenName,
  isScreenLens,
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
 * The lens each lens-owning screen last reported, kept per screen and never
 * cleared.
 *
 * Keyed by screen because a single "current lens" slot cannot be kept right.
 * The obvious design clears it when the screen blurs, and that breaks twice:
 * opening one task over another (a notification tap) runs the new screen's
 * focus effect BEFORE the old screen's blur, so the blur wipes the lens the
 * new screen just set and the tag reads `none` until the user toggles; and
 * every exit records a false "same screen, no lens" crumb before the real
 * one. With the lens stored against its owner there is nothing to clear: the
 * effective lens is whatever the CURRENT screen's entry says, and a screen
 * that owns no lens has no entry.
 */
const lensByScreen = new Map<LensScreenName, ScreenLens>();

/** What the scope holds now, so an unchanged pair costs nothing and records nothing. */
let reportedScreen: ScreenName | null = null;
let reportedLens: ScreenLens | null = null;

function effectiveLens(): ScreenLens {
  // `none`, never an absent tag: the native bridge stringifies whatever it is
  // handed, so clearing a tag with `undefined` would arrive as the text
  // "undefined" on a native event.
  return isLensScreenName(currentScreen) ? (lensByScreen.get(currentScreen) ?? 'none') : 'none';
}

function writeScreenTags(screen: ScreenName, lens: ScreenLens): void {
  Sentry.setTag(SCREEN_TAG, screen);
  Sentry.setTag(LENS_TAG, lens);
}

function applyScreenContext(): void {
  const lens = effectiveLens();
  if (currentScreen === reportedScreen && lens === reportedLens) return;
  reportedScreen = currentScreen;
  reportedLens = lens;
  try {
    writeScreenTags(currentScreen, lens);
    Sentry.addBreadcrumb({
      category: NAVIGATION_BREADCRUMB_CATEGORY,
      level: 'info',
      // The pair and nothing else. No route params, no previous screen (the
      // crumb before this one is that), no free text.
      data: { screen: currentScreen, lens },
    });
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
  currentScreen = screenNameFromSegments(segments);
  applyScreenContext();
}

/**
 * Reports the lens a lens-owning screen is on. The screen names itself, so the
 * lens is stored against its owner (see `lensByScreen`) and takes effect only
 * while that screen is the one showing.
 */
export function setReportedLens(screen: LensScreenName, lens: Exclude<ScreenLens, 'none'>): void {
  if (!isCrashReportingInitialized()) return;
  if (!isLensScreenName(screen) || !isScreenLens(lens)) return;
  lensByScreen.set(screen, lens);
  applyScreenContext();
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
      data: { state },
    });
  } catch {
    // See applyScreenContext.
  }
}
