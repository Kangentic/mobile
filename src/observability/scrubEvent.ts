import type { Breadcrumb, ErrorEvent } from '@sentry/react-native';

/**
 * Breadcrumb categories this app allows through to Sentry, default-deny
 * rather than default-allow: an unanticipated category (a native SDK
 * breadcrumb this list did not plan for) must be dropped, not silently
 * forwarded. 'sentry.event' is Sentry's own "an event was sent" bookkeeping
 * breadcrumb, the one category the app's breadcrumbsIntegration options
 * leave enabled.
 */
const ALLOWED_BREADCRUMB_CATEGORIES = new Set<string>(['sentry.event']);

export function allowlistBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category !== undefined && ALLOWED_BREADCRUMB_CATEGORIES.has(breadcrumb.category)) {
    return breadcrumb;
  }
  return null;
}

/**
 * Removes fields Sentry does not need for a crash report from an
 * accountless, E2E-encrypted app: no per-device user identity, no captured
 * HTTP request (this app makes none through Sentry's instrumentation, but
 * the field exists on every event), no arbitrary `extra`, no server name
 * (this app has no server), no captured HTTP response context.
 *
 * WHAT THIS CANNOT DO, AND WHY: an event's stack frames cannot be scoped by
 * source file here. Under Expo, @sentry/react-native's rewrite-frames
 * integration replaces every frame's `filename` with one constant bundle
 * name (`app:///index.android.bundle` / `app:///main.jsbundle`) before
 * beforeSend ever runs - real source paths are resolved only server-side,
 * after ingestion, from the uploaded source map. A per-module redaction
 * rule ("if the top frame is under src/notifications/, redact the
 * message") is therefore not implementable on-device and is not attempted.
 *
 * What actually keeps src/pairing/**, src/channel/**, and
 * src/notifications/** content out of Sentry is upstream of this function:
 * those directories cannot import Sentry at all (ESLint-enforced, see
 * .claude/rules/crash-reporting-scope.md), and their own long-standing
 * convention is to catch and discard every error without ever logging or
 * rethrowing it (.claude/rules/e2e-notification-privacy.md), so no
 * exception carrying their content should reach this function to begin
 * with. If that invariant is ever broken by a future change, this function
 * has no way to catch it - that residual gap is named in the rule file
 * rather than papered over with a check that would never fire.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const { user: _user, request: _request, extra: _extra, server_name: _serverName, contexts, ...rest } = event;
  if (contexts === undefined || contexts.response === undefined) {
    return { ...rest, ...(contexts !== undefined ? { contexts } : {}) };
  }
  const { response: _response, ...scrubbedContexts } = contexts;
  return { ...rest, contexts: scrubbedContexts };
}
