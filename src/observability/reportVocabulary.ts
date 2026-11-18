/**
 * Every value this app itself may put on a crash report, as closed sets.
 *
 * A report that cannot say where the app was or what it was doing cannot be
 * acted on (Sentry MOBILE-H, an iOS app hang whose event named no screen; and
 * MOBILE-8 before it). So the app adds three things to the scope: which screen
 * is showing, which lens that screen is on, and the state of the connection to
 * the desktop. `reportContext.ts` is the only writer.
 *
 * WHY CLOSED SETS, AND NOT STRINGS. What a report may carry about a screen is
 * its fixed name and never which task it shows: a route parameter here is one
 * of the desktop's task IDs. A function that passed a path through would keep
 * that promise only for as long as every caller handed it a template. A record
 * of the legal values keeps it whatever a caller passes, because a resolved
 * path such as `/task/8f3a` is simply not a member and comes out as `unknown`.
 * The same pattern holds the handled-error door's refusal codes
 * (`CAPABILITY_ERROR_CODES` in crashReporting.ts).
 *
 * This module has no imports on purpose. It is the vocabulary, so it must be
 * loadable by the pure vitest tier and by `src/state/` without pulling in the
 * Sentry SDK, which reads a native module at import time.
 *
 * Adding a member changes what leaves a device: see
 * .claude/rules/crash-reporting-scope.md, docs/privacy-policy.md and
 * docs/security.md.
 */

/**
 * The route templates under `app/`, one per screen file, with `(group)`
 * segments dropped the way expo-router drops them from a URL. A record rather
 * than a list so membership is one property lookup.
 * `tests/unit/reportVocabulary.test.ts` walks `app/` and fails when a route
 * file has no entry here or an entry has no route file, so a new screen cannot
 * ship reporting as `unknown` without CI saying so.
 */
const ROUTE_SCREEN_NAMES = {
  '/': true,
  '/board': true,
  '/task/[taskId]': true,
  '/task/[taskId]/changes': true,
  '/command-terminal': true,
  '/command-terminals': true,
  '/command-terminal-actions': true,
  '/completed-task': true,
  '/create-task': true,
  '/edit-task': true,
  '/move-task': true,
  '/task-actions': true,
  '/task-artifacts': true,
  '/project-picker': true,
  '/section-filter': true,
  '/workflow': true,
  '/workflows': true,
  '/file-diff': true,
  '/pair': true,
  '/pair-confirm': true,
  '/settings': true,
  '/devices': true,
  '/+not-found': true,
} as const;

export type RouteScreenName = keyof typeof ROUTE_SCREEN_NAMES;

/**
 * `none` is "no screen has rendered yet", the value from launch until the
 * first route commits. It is what a headless launch reports (a push that wakes
 * a killed app runs the bundle entry and never mounts a navigator), which is
 * itself the answer to "which screen was showing".
 *
 * `unknown` is "a screen rendered and its name is not in the set". It should
 * never be delivered: it means a route file was added without an entry above,
 * which the parity test catches first.
 */
export type ScreenName = RouteScreenName | 'none' | 'unknown';

/** Every route template, for the test that holds the record to `app/`. */
export const ROUTE_SCREEN_NAME_LIST = Object.keys(ROUTE_SCREEN_NAMES) as readonly RouteScreenName[];

function isRouteScreenName(candidate: string): candidate is RouteScreenName {
  return Object.prototype.hasOwnProperty.call(ROUTE_SCREEN_NAMES, candidate);
}

function isRouteGroupSegment(segment: string): boolean {
  return segment.startsWith('(') && segment.endsWith(')');
}

/**
 * The screen's fixed name, from expo-router's `useSegments()`.
 *
 * Segments are the FILE path, unnormalized: `app/task/[taskId]/index.tsx`
 * reads `['task', '[taskId]']` whichever task is open, and `app/(tabs)/index.tsx`
 * reads `['(tabs)']`. That is the property this relies on, and it is the
 * opposite of `usePathname()`, which substitutes the parameter and would read
 * `/task/<the task's id>`.
 *
 * The membership check is what makes the difference safe rather than merely
 * true today. Hand this a resolved path's parts and it answers `unknown`.
 */
export function screenNameFromSegments(segments: readonly string[]): ScreenName {
  const template = `/${segments.filter((segment) => !isRouteGroupSegment(segment)).join('/')}`;
  return isRouteScreenName(template) ? template : 'unknown';
}

/**
 * The screens that set the `screen` tag and leave NO entry on the trail: the
 * two steps of the pairing ceremony.
 *
 * Pairing's convention in this app is silence. The handled-error door may not
 * be called for a pairing failure even from a screen, because "a ceremony
 * failure's existence and timing is itself information about a pairing
 * attempt" (.claude/rules/crash-reporting-scope.md). A trail entry for `/pair`
 * followed by one for `/pair-confirm`, each with its timestamp, is that same
 * information arriving by another route: the first delivered event of task
 * #152 showed exactly those two entries, eight seconds apart, ahead of the
 * connection coming up.
 *
 * The TAG still names them. A crash on the scan screen has to say where it
 * was, the stack trace says as much on its own, and a tag is the state at the
 * moment of failure rather than a record of what the user did before it.
 */
const TRAIL_SILENT_SCREEN_NAMES = {
  '/pair': true,
  '/pair-confirm': true,
} as const satisfies Partial<Record<RouteScreenName, true>>;

export function isTrailSilentScreen(candidate: ScreenName): boolean {
  return Object.prototype.hasOwnProperty.call(TRAIL_SILENT_SCREEN_NAMES, candidate);
}

/**
 * The surface showing on a screen that has more than one. A task's session is
 * terminal, chat or changes; a Command Terminal the same; a completed task is
 * conversation, summary or description. `none` is every other screen.
 */
const SCREEN_LENSES = {
  none: true,
  terminal: true,
  chat: true,
  changes: true,
  conversation: true,
  summary: true,
  description: true,
} as const;

export type ScreenLens = keyof typeof SCREEN_LENSES;

export function isScreenLens(candidate: unknown): candidate is ScreenLens {
  return typeof candidate === 'string' && Object.prototype.hasOwnProperty.call(SCREEN_LENSES, candidate);
}

/** The screens that own a lens. A lens is only ever reported while one of these is showing. */
const LENS_SCREEN_NAMES = {
  '/task/[taskId]': true,
  '/command-terminal': true,
  '/completed-task': true,
} as const satisfies Partial<Record<RouteScreenName, true>>;

export type LensScreenName = keyof typeof LENS_SCREEN_NAMES;

export function isLensScreenName(candidate: unknown): candidate is LensScreenName {
  return typeof candidate === 'string' && Object.prototype.hasOwnProperty.call(LENS_SCREEN_NAMES, candidate);
}

/**
 * What the connection to the desktop was doing, as the trail records it.
 *
 * - `connecting`: the first dial of a connection.
 * - `connected`: the socket to the relay is open. Not yet a secure session.
 * - `established`: the Noise handshake finished, so the desktop is there.
 * - `reconnecting`: the link dropped and the transport is retrying.
 * - `closed`: the app closed the connection (a background, an unpair) or the
 *   transport did.
 * - `board-snapshot`: the first board snapshot of this secure session was
 *   applied, which is the bootstrap landing and a feed re-rendering with it.
 *
 * Deliberately absent: a rekey (one every two minutes or so would spend the
 * trail on a heartbeat), and anything about pairing, whose convention is
 * silence (.claude/rules/crash-reporting-scope.md).
 */
const CONNECTION_BREADCRUMB_STATES = {
  connecting: true,
  connected: true,
  established: true,
  reconnecting: true,
  closed: true,
  'board-snapshot': true,
} as const;

export type ConnectionBreadcrumbState = keyof typeof CONNECTION_BREADCRUMB_STATES;

/** Every state, for the test that holds emitted values to the union. */
export const CONNECTION_BREADCRUMB_STATE_LIST = Object.keys(
  CONNECTION_BREADCRUMB_STATES,
) as readonly ConnectionBreadcrumbState[];

export function isConnectionBreadcrumbState(candidate: unknown): candidate is ConnectionBreadcrumbState {
  return typeof candidate === 'string' && Object.prototype.hasOwnProperty.call(CONNECTION_BREADCRUMB_STATES, candidate);
}
