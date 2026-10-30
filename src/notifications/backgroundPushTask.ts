import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import notifee from '@notifee/react-native';
import { useChannelStore } from '@/state/channelStore';
import {
  ANDROID_NOTIFICATION_PRESENTATION,
  NEEDS_ATTENTION_CHANNEL_ID,
  channelIdForCategory,
  createNotificationChannels,
} from './channels';
import {
  PUSH_PLACEHOLDER_BODY,
  PUSH_PLACEHOLDER_TITLE,
  decryptPushBlob,
  decryptPushClear,
  extractBlobFromTaskData,
  extractClearFromTaskData,
  pushPayloadCarriesClear,
  type DecryptedPushNotification,
} from './pushDecrypt';
import { POSTED_AT_DATA_KEY, stampPosting } from './notificationRouting';
import { noteNotificationDisplayed } from './notificationSignals';
import { dismissNotificationsClearedBy } from './notificationReconciler';

// Re-exported from its new home in pushDecrypt.ts (the iOS tap router needs it
// too, and that path must not import notifee). Kept here so this module's own
// import path stays valid for callers and tests - not dead code.
export { extractBlobFromTaskData };

/**
 * The killed-app remote-push path: the desktop's Expo push arrives as an
 * FCM data message whose data.blob is the sealed envelope, expo-task-manager
 * boots this bundle headlessly, and this task decrypts and posts the rich
 * local notification via notifee. Any failure anywhere degrades to the
 * generic placeholder (e2e-notification-privacy.md) - the user still gets
 * nudged, and nothing sensitive is ever shown or logged.
 *
 * THIS TASK IS THE ONLY THING THAT RENDERS AN ANDROID PUSH. The message is
 * deliberately data-only, so there is no OS-drawn notification behind it to
 * fall back on: whatever this task fails to post is simply never seen. That
 * is why each step below degrades rather than returns, and why the one
 * genuinely unrecoverable case is commented as such instead of being left to
 * look like an oversight.
 *
 * The ONE message that must display nothing is a sealed clear (protocol
 * 0.23.0, `data.clear`): it only removes alerts, and every failure on its path
 * is silent rather than the placeholder. See applySealedClear and
 * registerBackgroundPushTask, which also explains the clears-only role this
 * task plays on iOS.
 */

const BACKGROUND_PUSH_TASK_NAME = 'kangentic-background-push';

/**
 * Whether the headless receive task actually registered with
 * expo-notifications. 'pending' covers both "not tried yet" and iOS, where
 * the task applies sealed clears only and never decides whether an alert can
 * be seen, so its registration is not tracked here.
 *
 * Exists because the registration failure below is otherwise unobservable:
 * nothing reads the task name, so an install that can never receive a push
 * still reported "Remote push: registered" in Settings. Content-free by
 * necessity - crash-reporting-scope.md bans this directory from reporting to
 * Sentry at all, so a local status is the only signal available.
 */
export type BackgroundPushTaskStatus = 'registered' | 'unavailable' | 'pending';

let backgroundPushTaskStatus: BackgroundPushTaskStatus = 'pending';

/** For the Settings push-status line, which pairs it with getPushRegistrationStatus(). */
export function getBackgroundPushTaskStatus(): BackgroundPushTaskStatus {
  return backgroundPushTaskStatus;
}

async function displayPlaceholder(): Promise<void> {
  // The posting time is the only data the placeholder carries: no routing, no
  // content. It is what lets the reconciler dismiss it once every project has
  // been re-read AFTER it (see notificationStaleness.ts). The id stays random,
  // since a placeholder names nothing a repeat could replace.
  const postedAt = Date.now();
  const platformId = await notifee.displayNotification({
    title: PUSH_PLACEHOLDER_TITLE,
    body: PUSH_PLACEHOLDER_BODY,
    data: { [POSTED_AT_DATA_KEY]: String(postedAt) },
    android: {
      ...ANDROID_NOTIFICATION_PRESENTATION,
      channelId: NEEDS_ATTENTION_CHANNEL_ID,
      pressAction: { id: 'default', launchActivity: 'default' },
    },
  });
  noteNotificationDisplayed({ platformId, routing: null, postedAt, promptIdAtPost: null });
}

async function displayDecryptedOrPlaceholder(decrypted: DecryptedPushNotification | null): Promise<void> {
  if (decrypted) {
    try {
      const postedAt = Date.now();
      // A stable id, so a repeat alert for the same session and category
      // REPLACES this one instead of stacking under it.
      const posting = stampPosting(decrypted.data, postedAt);
      const platformId = await notifee.displayNotification({
        ...posting.idField,
        title: decrypted.title,
        body: decrypted.body,
        data: posting.data,
        android: {
          ...ANDROID_NOTIFICATION_PRESENTATION,
          channelId: channelIdForCategory(decrypted.category),
          pressAction: { id: 'default', launchActivity: 'default' },
        },
      });
      noteNotificationDisplayed({ platformId, routing: posting.routing, postedAt, promptIdAtPost: null });
      return;
    } catch {
      // FALLING THROUGH TO THE PLACEHOLDER IS THE POINT. This catch used to
      // be absent, so a display failure on the DECRYPTED branch escaped past
      // the placeholder below into the task's outer catch and the user saw
      // nothing at all - the one path where a successful decrypt produced
      // less than a failed one.
      //
      // What this defends against is a failure SPECIFIC to the rich post - an
      // over-long payload, or something wrong with the one category channel it
      // resolved - which the plain placeholder on needs-attention does not
      // share. It is deliberately NOT the defence against channel creation
      // having failed wholesale: the placeholder draws on the same batch, so it
      // would fail too, and that case is handled one level up where the
      // creation itself is awaited and swallowed.
    }
  }
  await displayPlaceholder();
}

/**
 * Whether the phone is demonstrably watching this content already.
 *
 * TWO POLARITIES, BOTH LOAD-BEARING, AND THEY POINT OPPOSITE WAYS.
 *
 * App state: suppress only when PROVABLY active, never `!== 'background'` the
 * way localNotifier does. This task runs headlessly in a killed-app launch
 * where there is no resumed Activity, and AppState.currentState is then
 * whatever the native module reports for a paused context rather than a
 * provable 'active' - most likely 'background', possibly null or 'unknown'
 * depending on module availability. The gate deliberately does not care which:
 * `!== 'active'` treats them all as "not watching". Testing the other way round
 * would silently kill the killed-app push path, which is the entire reason this
 * task exists.
 *
 * Channel: suppress unless the channel is PROVABLY DOWN. The desktop already
 * skips devices with a live bridge session, but that is coarse - a relay
 * hiccup, a reconnect, or the five-minute BACKGROUND_KEEPALIVE_MAX_MS ceiling
 * landing while the user is actually looking at the app all get a push
 * through, and firing those over the top of the UI is the noise this guard
 * exists to stop. `established` alone is the wrong test: it drops on EVERY
 * transport blip (channelStore.ts), so a momentary reconnect would notify.
 *
 * KNOW HOW NARROW THE LET-THROUGH ACTUALLY IS. RelayTransport only reaches
 * 'closed' on an explicit close() and only sits at 'idle' before its first
 * dial (relayTransport.ts); a foreground outage retries forever, cycling
 * 'connecting'/'reconnecting'. So a foregrounded phone in a dead zone still
 * reads as watching, and this half really only lets a push through before the
 * first connect or after a deliberate teardown. That is accepted rather than
 * fixed here: separating a blip from a sustained outage needs a time-in-state
 * the store does not carry, and a foregrounded user already has the connection
 * banner telling them the link is down. A fresh headless launch reads 'idle',
 * so this half fails safe too.
 *
 * Reading the store is safe from the headless entry path, which is not
 * automatic in this directory (permissionCache.ts is deliberately zero-import,
 * categoryCopy.ts deliberately notifee-free). channelStore.ts is zustand plus a
 * TYPE-only protocol import, and module scope only constructs a plain object -
 * no native module, no React render, nothing that needs an Activity. It is
 * never persisted either, so a killed-app launch always reads the initial
 * state rather than a stale snapshot of a connection that is long gone.
 */
function watchingAlready(): boolean {
  try {
    if (AppState.currentState !== 'active') return false;
    const { established, transportState } = useChannelStore.getState();
    return established || (transportState !== 'idle' && transportState !== 'closed');
  } catch {
    // FAIL OPEN. Nothing here does I/O, so this should be unreachable - but it
    // is the one statement in the executor that sat outside a catch, and this
    // file's whole contract is degrade, never throw. A gate that cannot read
    // its own inputs must not be the reason a notification is swallowed.
    return false;
  }
}

/**
 * A sealed clear (protocol 0.23.0): the desktop saw notifications it already
 * sent resolve. Removes the ones it covers and DISPLAYS NOTHING, on every path.
 * A clear that cannot be opened (no key, wrong key, tampered, stale, malformed,
 * a non-string value) does nothing at all, and explicitly not the placeholder:
 * a clear is never a reason to notify (e2e-notification-privacy.md).
 */
async function applySealedClear(payload: unknown): Promise<void> {
  try {
    const blob = extractClearFromTaskData(payload);
    if (blob === null) return;
    const entries = await decryptPushClear(blob);
    if (entries === null) return;
    await dismissNotificationsClearedBy(entries);
  } catch {
    // Silent by design: see above.
  }
}

let taskRegistered = false;

/**
 * Registers the receive task on BOTH platforms, with two different jobs.
 *
 * - Android: every push lands here (data-only), so this task renders it, and
 *   applies any sealed clear: a standalone one, or `clears` riding a
 *   notification envelope, which are applied before that envelope displays.
 * - iOS: the OS draws every alert from the APNs request, and the Notification
 *   Service Extension applies the `clears` a visible push carries
 *   (targets/nse/). This task only ever applies a STANDALONE clear, which the
 *   desktop sends as a background (`content-available`) push with no alert, so
 *   it needs the `remote-notification` background mode (app.config.ts).
 *   expo-notifications also runs this task for a visible push received in the
 *   foreground, so the iOS branch returns before anything that could display:
 *   a notifee post there would sit on top of the alert iOS already shows.
 *   iOS delivers background pushes only when it chooses to (Apple's guidance
 *   is two or three an hour) and never to an app the user force-quit, so this
 *   path is best-effort; the extension is the reliable half.
 *
 * The status the Settings push line reads moves on Android only. On iOS the
 * task decides nothing about whether an alert can be SEEN, so a failed
 * registration there must not report remote push as unavailable.
 */
export function registerBackgroundPushTask(): void {
  if (taskRegistered) return;
  taskRegistered = true;
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(BACKGROUND_PUSH_TASK_NAME, async ({ data, error }) => {
    if (error || !data) return;
    // Notification-response payloads (action taps) are the tap router's
    // job; this task only handles incoming data messages.
    if ('actionIdentifier' in data) return;
    // A clear is recognised by its KEY, before anything is decrypted and
    // before the watching gate: the desktop already resolved what it names,
    // so it applies whether or not the user is looking. Checked first because
    // a payload with no `blob` falls through to the placeholder below, and a
    // clear must never become a notification.
    if (pushPayloadCarriesClear(data.data)) {
      await applySealedClear(data.data);
      return;
    }
    if (Platform.OS !== 'android') return;
    // Decrypted BEFORE the watching gate so the clears it carries are applied
    // even while the user is looking: an Android clear the desktop piggybacked
    // is consumed once Expo accepts the push, so dropping it here would lose
    // the only copy.
    const blob = extractBlobFromTaskData(data.data);
    const decrypted = blob === null ? null : await decryptPushBlob(blob);
    try {
      if (decrypted !== null && decrypted.clears.length > 0) await dismissNotificationsClearedBy(decrypted.clears);
    } catch {
      // Never costs the notification it rode on.
    }
    // Nothing fires over the top of a live session the user is watching, except
    // a Notify me push (protocol 0.26.0): the user asked to be told, the
    // desktop sends it to a connected phone on purpose, and nothing in the app
    // shows it instead.
    if (watchingAlready() && decrypted?.authored !== true) return;
    // The channels displayed into are created by initializeNotifications(),
    // but as an UNAWAITED `void` call (index.ts) issued immediately after
    // this task is registered - so on a cold headless launch the display
    // below can outrun it, and notifee rejects a display against a channel
    // that does not exist yet.
    //
    // THIS AWAIT ONLY MEANS SOMETHING BECAUSE channels.ts MEMOIZES THE
    // IN-FLIGHT PROMISE. index.js runs initializeNotifications() at bundle
    // entry on every launch, headless included, so that unawaited call has
    // ALWAYS started before this task can run. Against the boolean guard it
    // used to keep - flipped synchronously, before its own await - this line
    // returned immediately and waited on nothing, which is the exact race it
    // was added to close. Sharing the promise is what makes it join the real
    // creation instead; a revert to a plain flag silently re-breaks it.
    //
    // Swallowed separately so a channel failure still lets the display try:
    // by far the common case is that the channels already exist OS-side from
    // an earlier launch and this call had nothing to do.
    try {
      await createNotificationChannels();
    } catch {
      // See above.
    }
    try {
      await displayDecryptedOrPlaceholder(decrypted);
    } catch {
      // The placeholder itself failed, which is the one case with nothing
      // left to degrade to: notifee is the only renderer this message has.
      // Swallowing keeps the headless task from crash-looping.
    }
  });
  const tracksStatus = Platform.OS === 'android';
  void Notifications.registerTaskAsync(BACKGROUND_PUSH_TASK_NAME)
    .then(() => {
      if (tracksStatus) backgroundPushTaskStatus = 'registered';
    })
    .catch(() => {
      // Without FCM credentials (no google-services.json) registration can
      // fail; remote push is simply unavailable, never a boot failure.
      // Recorded rather than swallowed outright so Settings can stop
      // reporting "registered" for an install that can never receive one.
      if (tracksStatus) backgroundPushTaskStatus = 'unavailable';
    });
}
