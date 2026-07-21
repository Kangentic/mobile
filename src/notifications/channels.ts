import notifee, { AndroidImportance, AuthorizationStatus } from '@notifee/react-native';
import {
  NEEDS_ATTENTION_CHANNEL_ID,
  COMPLETIONS_CHANNEL_ID,
  FAILURES_CHANNEL_ID,
  STALLS_CHANNEL_ID,
  CONNECTION_CHANNEL_ID,
  channelIdForCategory,
  titleForCategory,
} from './categoryCopy';

/**
 * Android notification channels, mirroring the desktop's push channel
 * names (needs-attention / completions / failures / stalls) so local and
 * remote notifications for the same event class land under one
 * user-controllable channel. 'connection' is phone-only: the
 * LOW-importance ongoing foreground-service notification.
 *
 * The category -> channel-id / title mapping itself lives in
 * categoryCopy.ts (no notifee import there); re-exported here so existing
 * callers of this module keep working.
 */

export {
  NEEDS_ATTENTION_CHANNEL_ID,
  COMPLETIONS_CHANNEL_ID,
  FAILURES_CHANNEL_ID,
  STALLS_CHANNEL_ID,
  CONNECTION_CHANNEL_ID,
  channelIdForCategory,
  titleForCategory,
};

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
      description: 'An agent finished its turn or a plan was approved.',
      importance: AndroidImportance.DEFAULT,
    },
    {
      id: FAILURES_CHANNEL_ID,
      name: 'Failures',
      description: 'An agent session stopped unexpectedly.',
      importance: AndroidImportance.HIGH,
    },
    {
      id: STALLS_CHANNEL_ID,
      name: 'Slow starts',
      description: 'A task is taking a while to start.',
      importance: AndroidImportance.DEFAULT,
    },
    {
      id: CONNECTION_CHANNEL_ID,
      name: 'Desktop connection',
      description: 'Shown while Kangentic keeps the secure channel to your desktop alive in the background.',
      importance: AndroidImportance.LOW,
    },
  ]);
}

/** Android 13+ runtime notification permission (POST_NOTIFICATIONS), via notifee. */
export async function requestNotificationPermission(): Promise<boolean> {
  const settings = await notifee.requestPermission();
  return (
    settings.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
    settings.authorizationStatus === AuthorizationStatus.PROVISIONAL
  );
}
