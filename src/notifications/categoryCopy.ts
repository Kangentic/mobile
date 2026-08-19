import type { PushCategory } from '@kangentic/protocol';

/**
 * Pure category -> channel-id / title mapping, deliberately split out of
 * channels.ts: this file has NO notifee import, so it is safe for
 * pushDecrypt.ts (the on-device decrypt path, unit-tested in a plain Node
 * environment) to depend on without pulling in notifee's React Native
 * module, which throws outside a React Native runtime. channels.ts
 * re-exports these for its own (notifee-backed) callers.
 */

export const NEEDS_ATTENTION_CHANNEL_ID = 'needs-attention';
export const COMPLETIONS_CHANNEL_ID = 'completions';
export const FAILURES_CHANNEL_ID = 'failures';
export const STALLS_CHANNEL_ID = 'stalls';
export const CONNECTION_CHANNEL_ID = 'connection';

/** The channel a decrypted (or locally observed) event class lands on. */
export function channelIdForCategory(category: PushCategory): string {
  switch (category) {
    case 'input-required':
      return NEEDS_ATTENTION_CHANNEL_ID;
    case 'turn-complete':
    case 'plan-complete':
      return COMPLETIONS_CHANNEL_ID;
    case 'session-failed':
      return FAILURES_CHANNEL_ID;
    case 'spawn-stalled':
      return STALLS_CHANNEL_ID;
  }
}

/**
 * The notification title for a category - shared by the decrypt path
 * (pushDecrypt.ts, for a remote push) and the local notifier (activity-
 * store transitions while backgrounded), so the two can never drift.
 */
export function titleForCategory(category: PushCategory): string {
  switch (category) {
    case 'input-required':
      return 'Agent needs your input';
    // The wire id stays 'turn-complete' (changing it would be a protocol
    // release), but the signal no longer means "a turn ended". Both producers
    // now settle-debounce it, so it fires once when a session goes quiet rather
    // than once per reply - see localNotifier's idle timer and the desktop's.
    case 'turn-complete':
      return 'Agent went idle';
    case 'session-failed':
      return 'Session stopped';
    case 'plan-complete':
      return 'Plan complete';
    case 'spawn-stalled':
      return 'Still preparing';
  }
}
