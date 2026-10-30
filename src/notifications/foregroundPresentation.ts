import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { decryptPushBlob, extractBlobFromTaskData } from './pushDecrypt';

/**
 * What iOS does with a push that arrives while the app is open.
 *
 * Every alert stays hidden in the foreground, as it always has: the app itself
 * is the surface there, and with no handler set expo-notifications answers
 * `willPresent` with no presentation options at all
 * (NotificationCenterManager.swift). The one exception is a Notify me push
 * (protocol 0.26.0): the user asked to be told, the desktop sends it to a
 * connected phone on purpose, and nothing in the app shows it otherwise. So
 * this handler presents a banner for an authored envelope and nothing for any
 * other. The Android twin is the `authored` exemption in backgroundPushTask.
 *
 * By the time this runs the Notification Service Extension has normally
 * replaced the placeholder with the decrypted title and body. When it could
 * not (it ran out of time, or its Keychain read failed) the generic placeholder
 * arrives as delivered, and an authored push still shows, as that placeholder.
 * Either way the banner reads as the lock-screen alert would. The blob is
 * decrypted here only to learn WHICH kind of push it is; nothing is logged,
 * and every failure of that decrypt (no blob, no key, a stale or tampered
 * envelope, a throw) keeps today's hidden behaviour.
 */

const HIDDEN_IN_FOREGROUND: Notifications.NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

const SHOWN_IN_FOREGROUND: Notifications.NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

export async function foregroundBehaviorFor(notification: Notifications.Notification): Promise<Notifications.NotificationBehavior> {
  try {
    const blob = extractBlobFromTaskData(notification.request.content.data);
    if (blob === null) return HIDDEN_IN_FOREGROUND;
    const decrypted = await decryptPushBlob(blob);
    return decrypted?.authored === true ? SHOWN_IN_FOREGROUND : HIDDEN_IN_FOREGROUND;
  } catch {
    // Silent by design (e2e-notification-privacy.md): never log, never show.
    return HIDDEN_IN_FOREGROUND;
  }
}

let registered = false;

/**
 * iOS only. Android pushes are data-only and drawn by the headless task, so a
 * handler there would govern nothing this app posts.
 */
export function registerForegroundPresentation(): void {
  if (registered || Platform.OS !== 'ios') return;
  registered = true;
  Notifications.setNotificationHandler({ handleNotification: foregroundBehaviorFor });
}
