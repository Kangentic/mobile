import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import notifee from '@notifee/react-native';
import { useActivityStore, type SessionActivityEntry } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { COMPLETIONS_CHANNEL_ID, FAILURES_CHANNEL_ID, NEEDS_ATTENTION_CHANNEL_ID } from './channels';

/**
 * The foreground-service mode's local alerting: while the app is
 * BACKGROUNDED with the secure channel still alive, activity-store
 * transitions become notifee notifications, giving instant local alerts
 * without any push infrastructure. Subscribing to the store (not the wire)
 * means mock, stub, and live modes all behave identically. Fully
 * suppressed while the app is foregrounded - the in-app UI is the surface
 * there - and the desktop suppresses its remote push while this phone's
 * channel is established, so local and remote never double-fire.
 */

type LocalNotificationKind = 'permission' | 'turn-complete' | 'session-ended';

/** Matches the desktop's own per-(session, kind) push cooldown. */
const LOCAL_NOTIFICATION_COOLDOWN_MS = 30_000;

/**
 * The activity store's feedStatus union gains 'ended' in a parallel
 * workstream (the desktop already pushes session-ended activity events);
 * widening locally keeps this notifier forward-compatible without
 * touching the store's type.
 */
type FeedStatusMaybeEnded = SessionActivityEntry['feedStatus'] | 'ended';

function titleForKind(kind: LocalNotificationKind): string {
  switch (kind) {
    case 'permission':
      return 'Agent needs your attention';
    case 'turn-complete':
      return 'Turn complete';
    case 'session-ended':
      return 'Session stopped';
  }
}

function channelIdForKind(kind: LocalNotificationKind): string {
  switch (kind) {
    case 'permission':
      return NEEDS_ATTENTION_CHANNEL_ID;
    case 'turn-complete':
      return COMPLETIONS_CHANNEL_ID;
    case 'session-ended':
      return FAILURES_CHANNEL_ID;
  }
}

function resolveTaskTitle(entry: SessionActivityEntry): string {
  const boardTask = useBoardStore.getState().boardsByProjectId[entry.projectId]?.tasksById[entry.taskId];
  return boardTask && boardTask.title.length > 0 ? boardTask.title : 'Agent session';
}

function kindsForTransition(entry: SessionActivityEntry, previousEntry: SessionActivityEntry | undefined): LocalNotificationKind[] {
  const kinds: LocalNotificationKind[] = [];
  const enteredPermission = entry.state === 'permission' && previousEntry?.state !== 'permission';
  const promptChanged =
    entry.state === 'permission' && entry.awaitedPromptId !== null && previousEntry?.awaitedPromptId !== entry.awaitedPromptId;
  if (enteredPermission || promptChanged) kinds.push('permission');
  if (previousEntry?.state === 'thinking' && entry.state === 'idle') kinds.push('turn-complete');
  const feedStatus = entry.feedStatus as FeedStatusMaybeEnded;
  const previousFeedStatus = (previousEntry?.feedStatus ?? 'pending') as FeedStatusMaybeEnded;
  if (feedStatus === 'ended' && previousFeedStatus !== 'ended') kinds.push('session-ended');
  return kinds;
}

/**
 * Starts watching the activity store; returns the stop function. The
 * connection manager starts this when it keeps the channel alive on
 * background (foreground-service mode) and stops it on foreground.
 */
export function startLocalNotifier(): () => void {
  const lastFiredAtByKey = new Map<string, number>();
  let appStateStatus: AppStateStatus = AppState.currentState;
  const appStateSubscription: NativeEventSubscription = AppState.addEventListener('change', (status) => {
    appStateStatus = status;
  });

  const fire = (kind: LocalNotificationKind, entry: SessionActivityEntry): void => {
    const cooldownKey = `${entry.sessionId}:${kind}`;
    const now = Date.now();
    const lastFiredAt = lastFiredAtByKey.get(cooldownKey);
    if (lastFiredAt !== undefined && now - lastFiredAt < LOCAL_NOTIFICATION_COOLDOWN_MS) return;
    lastFiredAtByKey.set(cooldownKey, now);
    void notifee
      .displayNotification({
        title: titleForKind(kind),
        body: resolveTaskTitle(entry),
        data: { taskId: entry.taskId, projectId: entry.projectId, sessionId: entry.sessionId },
        android: {
          channelId: channelIdForKind(kind),
          pressAction: { id: 'default', launchActivity: 'default' },
        },
      })
      .catch(() => {
        // Display failures (channel blocked, permission revoked) are the
        // user's choice; nothing to do.
      });
  };

  let previousBySessionId = useActivityStore.getState().bySessionId;
  const unsubscribeStore = useActivityStore.subscribe((state) => {
    const currentBySessionId = state.bySessionId;
    if (currentBySessionId === previousBySessionId) return;
    const previous = previousBySessionId;
    previousBySessionId = currentBySessionId;
    // Track transitions even while foregrounded (above), but only notify
    // while backgrounded: the in-app UI is the foreground surface.
    if (appStateStatus !== 'background') return;
    for (const entry of Object.values(currentBySessionId)) {
      for (const kind of kindsForTransition(entry, previous[entry.sessionId])) fire(kind, entry);
    }
  });

  return () => {
    appStateSubscription.remove();
    unsubscribeStore();
    lastFiredAtByKey.clear();
  };
}
