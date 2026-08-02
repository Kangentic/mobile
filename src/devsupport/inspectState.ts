import type { SubscriptionManager } from '@/channel/subscriptionManager';

/**
 * Module-level registry the inspect bridge reads from and the app's
 * dev-gated call sites write into. Loaded only via dynamic import behind
 * the EXPO_PUBLIC_KANGENTIC_INSPECT gate, so production bundles never
 * include it (the same stripping arrangement as mockDesktop).
 */

export interface InspectRouteInfo {
  pathname: string;
  params: Record<string, string>;
}

/** Outcomes of the phone's PTY writes; see TerminalPane's terminalWriteStats. */
export interface InspectTerminalWriteStats {
  attempts: number;
  failures: number;
  lastError: string | null;
  lastAttemptAt: number;
}

/**
 * The mounted terminal pane's dev handle: a way to run an expression INSIDE the
 * xterm WebView (where all the geometry lives, unreachable from RN) plus the
 * write outcomes RN owns. Registered only while a pane is mounted, so a null
 * here means "no terminal on screen", which is itself the answer to most
 * "why did nothing happen" questions.
 */
export interface InspectTerminalHandle {
  sessionId: string;
  /** Build id the JS bundle expects; compare against the page's own. */
  expectedBuildId: string;
  evaluate: (expression: string) => Promise<unknown>;
  writeStats: () => InspectTerminalWriteStats;
}

let currentRoute: InspectRouteInfo | null = null;
let currentSubscriptions: SubscriptionManager | null = null;
let currentTerminal: InspectTerminalHandle | null = null;

export function setInspectRoute(route: InspectRouteInfo | null): void {
  currentRoute = route;
}

export function getInspectRoute(): InspectRouteInfo | null {
  return currentRoute;
}

export function setInspectSubscriptions(subscriptions: SubscriptionManager | null): void {
  currentSubscriptions = subscriptions;
}

export function getInspectSubscriptions(): SubscriptionManager | null {
  return currentSubscriptions;
}

export function setInspectTerminal(terminal: InspectTerminalHandle | null): void {
  currentTerminal = terminal;
}

export function getInspectTerminal(): InspectTerminalHandle | null {
  return currentTerminal;
}
