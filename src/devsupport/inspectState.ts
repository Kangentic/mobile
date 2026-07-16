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

let currentRoute: InspectRouteInfo | null = null;
let currentSubscriptions: SubscriptionManager | null = null;

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
