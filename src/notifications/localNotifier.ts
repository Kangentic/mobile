import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import notifee from '@notifee/react-native';
import type { PushCategory } from '@kangentic/protocol';
import { useActivityStore, type SessionActivityEntry } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useSettingsStore } from '@/state/settingsStore';
import { channelIdForCategory, titleForCategory } from './categoryCopy';

/**
 * The foreground-service mode's local alerting: while the app is
 * BACKGROUNDED with the secure channel still alive, activity-store
 * transitions become notifee notifications, giving instant local alerts
 * without any push infrastructure. Subscribing to the store (not the wire)
 * means mock, stub, and live modes all behave identically. Fully
 * suppressed while the app is foregrounded - the in-app UI is the surface
 * there - and the desktop suppresses its remote push while this phone's
 * channel is established, so local and remote never double-fire.
 *
 * Reuses the PushCategory vocabulary (titleForCategory / channelIdForCategory
 * from categoryCopy.ts, re-exported by channels.ts for its notifee-backed
 * callers) rather than a separate local kind set, so a remote push
 * and a local alert for the same event class always agree on copy and
 * channel. Only three categories have an activity-store signal to fire
 * from; plan-complete and spawn-stalled are push-only.
 */

/** Matches the desktop's own per-(session, category) push cooldown. */
const LOCAL_NOTIFICATION_COOLDOWN_MS = 30_000;

function resolveTaskTitle(entry: SessionActivityEntry): string {
  const boardTask = useBoardStore.getState().boardsByProjectId[entry.projectId]?.tasksById[entry.taskId];
  return boardTask && boardTask.title.length > 0 ? boardTask.title : 'Agent session';
}

function categoriesForTransition(entry: SessionActivityEntry, previousEntry: SessionActivityEntry | undefined): PushCategory[] {
  const categories: PushCategory[] = [];
  const enteredPermission = entry.state === 'permission' && previousEntry?.state !== 'permission';
  const promptChanged =
    entry.state === 'permission' && entry.awaitedPromptId !== null && previousEntry?.awaitedPromptId !== entry.awaitedPromptId;
  if (enteredPermission || promptChanged) categories.push('input-required');
  if (previousEntry?.state === 'thinking' && entry.state === 'idle') categories.push('turn-complete');
  // Only an UNINTENTIONAL end is worth waking someone for. A deliberate Stop,
  // suspend or shutdown is the user's own action taken at the desktop they are
  // sitting at, and this category is 'session-failed', not 'session-stopped'.
  // (The "Session stopped" copy in categoryCopy.ts stays as-is: it describes a
  // crash accurately, and docs/architecture.md enumerates it.)
  const endedUnintentionally = entry.feedStatus === 'ended' && entry.endedIntentionally === false;
  if (endedUnintentionally && previousEntry?.feedStatus !== 'ended') categories.push('session-failed');
  return categories;
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

  const fire = (category: PushCategory, entry: SessionActivityEntry): void => {
    // The same per-category toggle that filters remote push must also gate
    // the local alert - otherwise disabling a category in Settings still
    // fires it locally in foreground-service mode.
    if (useSettingsStore.getState().pushCategoriesEnabled[category] === false) return;
    const cooldownKey = `${entry.sessionId}:${category}`;
    const now = Date.now();
    const lastFiredAt = lastFiredAtByKey.get(cooldownKey);
    if (lastFiredAt !== undefined && now - lastFiredAt < LOCAL_NOTIFICATION_COOLDOWN_MS) return;
    lastFiredAtByKey.set(cooldownKey, now);
    void notifee
      .displayNotification({
        title: titleForCategory(category),
        body: resolveTaskTitle(entry),
        data: { taskId: entry.taskId, projectId: entry.projectId, sessionId: entry.sessionId },
        android: {
          channelId: channelIdForCategory(category),
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
      for (const category of categoriesForTransition(entry, previous[entry.sessionId])) fire(category, entry);
    }
  });

  return () => {
    appStateSubscription.remove();
    unsubscribeStore();
    lastFiredAtByKey.clear();
  };
}
