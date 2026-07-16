import notifee, { AndroidImportance, AuthorizationStatus } from '@notifee/react-native';
import type { PushCategory } from '@kangentic/protocol';

/**
 * Android notification channels, mirroring the desktop's push channel
 * names (needs-attention / completions / failures) so local and remote
 * notifications for the same event class land under one user-controllable
 * channel. 'connection' is phone-only: the LOW-importance ongoing
 * foreground-service notification.
 */

export const NEEDS_ATTENTION_CHANNEL_ID = 'needs-attention';
export const COMPLETIONS_CHANNEL_ID = 'completions';
export const FAILURES_CHANNEL_ID = 'failures';
export const CONNECTION_CHANNEL_ID = 'connection';

let channelsCreated = false;

/** Idempotent; creating an existing channel is a no-op OS-side, but the guard keeps boot paths cheap. */
export async function createNotificationChannels(): Promise<void> {
  if (channelsCreated) return;
  channelsCreated = true;
  await notifee.createChannels([
    {
      id: NEEDS_ATTENTION_CHANNEL_ID,
      name: 'Needs your attention',
      description: 'An agent is waiting on your approval or answer.',
      importance: AndroidImportance.HIGH,
    },
    {
      id: COMPLETIONS_CHANNEL_ID,
      name: 'Completions',
      description: 'An agent finished its turn.',
      importance: AndroidImportance.DEFAULT,
    },
    {
      id: FAILURES_CHANNEL_ID,
      name: 'Failures',
      description: 'An agent session stopped unexpectedly.',
      importance: AndroidImportance.HIGH,
    },
    {
      id: CONNECTION_CHANNEL_ID,
      name: 'Desktop connection',
      description: 'Shown while Kangentic keeps the secure channel to your desktop alive in the background.',
      importance: AndroidImportance.LOW,
    },
  ]);
}

/** The channel a decrypted (or locally observed) event class lands on. */
export function channelIdForCategory(category: PushCategory): string {
  switch (category) {
    case 'permission-needed':
    case 'agent-question':
      return NEEDS_ATTENTION_CHANNEL_ID;
    case 'turn-complete':
      return COMPLETIONS_CHANNEL_ID;
    case 'session-failed':
      return FAILURES_CHANNEL_ID;
  }
}

/** Android 13+ runtime notification permission (POST_NOTIFICATIONS), via notifee. */
export async function requestNotificationPermission(): Promise<boolean> {
  const settings = await notifee.requestPermission();
  return (
    settings.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
    settings.authorizationStatus === AuthorizationStatus.PROVISIONAL
  );
}
