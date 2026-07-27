import * as Sentry from '@sentry/react-native';
import { allowlistBreadcrumb, scrubEvent } from './scrubEvent';

/**
 * Crash and error reporting. Deliberately narrow: this app reports that it
 * broke and where in the code, and nothing about what the user was doing or
 * what their agent session contained.
 *
 * WHY THE CONTROLS LOOK LIKE THIS. A JavaScript `beforeSend` hook does NOT
 * filter native events - a hard iOS/Android crash is captured and sent by
 * sentry-cocoa / sentry-android and never passes through the JS layer at
 * all. So every control here is set at its SOURCE (an integration removed,
 * a feature disabled) rather than in a scrubber, because a scrubber cannot
 * reach the native path. This matters most for breadcrumbs: JS breadcrumbs
 * are synced into the native scope, so a console breadcrumb captured in JS
 * rides a native crash straight past `beforeSend`. Console breadcrumbs are
 * ON by default, which is why they are turned off explicitly below.
 *
 * See docs/security.md and .claude/rules/crash-reporting-scope.md.
 */

/**
 * Errors that are normal operating conditions on a phone, not defects. A
 * mobile app loses its socket constantly (tunnel, lift, screen off), and
 * `src/channel/relayTransport.ts` surfaces that as a plain Error. Left
 * unfiltered these alone would exhaust the free tier's 5,000 events/month
 * without describing a single real bug.
 */
const EXPECTED_TRANSPORT_NOISE: RegExp[] = [
  /Network request failed/i,
  /Relay connection closed before it opened/i,
  /RelayTransport\.send\(\) called while not connected/i,
];

let initialized = false;

/**
 * No DSN means no `Sentry.init()` at all, so the native SDK never starts
 * and nothing is collected or stored on device. That is the state for every
 * build a contributor or self-hoster makes from source: `EXPO_PUBLIC_SENTRY_DSN`
 * is injected from a GitHub secret at build time and is never committed, so
 * a fork reports nothing (and cannot burn this project's free-tier quota).
 */
export function initializeCrashReporting(): void {
  if (initialized) return;
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (dsn === undefined || dsn === '') return;
  initialized = true;

  Sentry.init({
    dsn,
    // Three environments, because all three would otherwise land in one
    // 5,000-event budget as "production" and be indistinguishable from a real
    // user's crash. E2E matters as much as dev here: a Maestro APK is
    // release-shaped, so __DEV__ is FALSE in it, and a dispatched
    // `profile=e2e` build does receive the DSN (the workflow's HAS_SENTRY gate
    // is job-level and covers every matrix profile). Without this branch every
    // smoke-flow crash would be filed as a production incident.
    environment: __DEV__
      ? 'development'
      : process.env.EXPO_PUBLIC_KANGENTIC_E2E === '1'
        ? 'e2e'
        : 'production',

    // --- Privacy, set at the source because beforeSend cannot reach native events ---
    sendDefaultPii: false,
    // Screens render agent transcripts, terminal output and diff content.
    // A screenshot or view hierarchy attached to a crash would carry all of
    // it, in cleartext, off the device.
    attachScreenshot: false,
    attachViewHierarchy: false,
    // Would capture failed HTTP requests, including the relay URL.
    enableCaptureFailedRequests: false,
    // A session is a per-foreground ping. It powers crash-free rate, which
    // is genuinely useful, but it is usage telemetry and this app tells
    // users it collects none. Flip deliberately, with a privacy-policy
    // edit, not as a side effect (docs/privacy-policy.md).
    enableAutoSessionTracking: false,
    // Transaction names carry route parameters, which here are the
    // desktop's task IDs.
    enableAutoPerformanceTracing: false,
    enableUserInteractionTracing: false,
    tracesSampleRate: 0,
    // Sentry's Logs product forwards console output as structured logs -
    // exactly the egress the console breadcrumb removal below prevents.
    enableLogs: false,

    // Session Replay is absent rather than disabled: no
    // `mobileReplayIntegration()` is registered and no replay sample rate
    // is set, so the SDK never loads it (it records screen content).
    integrations: (defaultIntegrations) => [
      ...defaultIntegrations.filter((integration) => integration.name !== 'Breadcrumbs'),
      Sentry.breadcrumbsIntegration({
        // `console` defaults to TRUE. Every console.* call in the app would
        // otherwise become a breadcrumb and sync to the native scope.
        console: false,
        // RN's global fetch is built on XHR, so `xhr` alone is what records
        // request URLs; both are set so neither default can leak one back.
        xhr: false,
        fetch: false,
        // Web-only, no-ops in React Native. Set so the intent survives if
        // this app ever renders through react-native-web.
        dom: false,
        history: false,
        // Sentry's own "an event was sent" bookkeeping. Carries no app data
        // and is the one category allowlistBreadcrumb lets through.
        sentry: true,
      }),
    ],

    // --- Free-tier volume (5,000 errors/month, 30-day retention) ---
    // Not sampled down: at this app's volume every one of those events is
    // wanted. Volume is controlled by not generating noise (above) and by
    // Spike Protection plus a per-key rate limit configured server-side -
    // see the crash reporting section of docs/developer-guide.md.
    sampleRate: 1.0,
    ignoreErrors: EXPECTED_TRANSPORT_NOISE,
    maxBreadcrumbs: 20,

    beforeBreadcrumb: allowlistBreadcrumb,
    beforeSend: scrubEvent,
  });
}
