import { openPushEnvelope, type PushCategory, type PushSessionKind } from '@kangentic/protocol';
import { getPushKeyIfExists } from './pushKeys';
import { getPushIdentityPublicKey } from './pushIdentity';
import { titleForCategory } from './categoryCopy';

/**
 * On-device decryption of a push envelope blob. Everything the OS-visible
 * payload carried was ciphertext plus a static placeholder; the real
 * content only exists after this function succeeds. Every failure mode
 * (missing key, wrong key, wrong recipient AAD, tampered or malformed
 * blob, stale/future sentAt) returns null and the caller shows the
 * generic placeholder - never ciphertext, never a partial decrypt, and
 * nothing here is ever logged (e2e-notification-privacy.md).
 */

export const PUSH_PLACEHOLDER_TITLE = 'Kangentic';
export const PUSH_PLACEHOLDER_BODY = 'Agent needs attention';

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The envelope blob can arrive directly as data.blob, or wrapped inside the
 * JSON string expo-notifications surfaces as data.dataString (or the FCM-level
 * `body` key on some delivery paths). Checked in that order.
 *
 * Lives here rather than next to the Android background task because BOTH
 * platforms need it now: the iOS tap router reads the same blob out of an
 * expo-notifications response. This module is the notifee-free one, so it is
 * the only place both callers can import from.
 */
export function extractBlobFromTaskData(data: unknown): string | null {
  if (!isUnknownRecord(data)) return null;
  if (typeof data.blob === 'string') return data.blob;
  const nestedJson = typeof data.dataString === 'string' ? data.dataString : typeof data.body === 'string' ? data.body : null;
  if (nestedJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(nestedJson);
    if (isUnknownRecord(parsed) && typeof parsed.blob === 'string') return parsed.blob;
  } catch {
    // Malformed JSON: fall through to null and the placeholder path.
  }
  return null;
}

/**
 * The routing identity a decrypted notification carries into notifee's
 * `data` (string values only, which notifee requires). `sessionKind` is set
 * only for a Command Terminal (protocol 0.20.0), whose `taskId` names no board
 * task: the tap then opens that terminal by `sessionId`, and must never open
 * the made-up task id as a task. A type alias rather than an interface, so it
 * assigns to notifee's string-keyed `data` as it is.
 */
export type DecryptedPushRouting = {
  taskId: string;
  projectId: string;
  sessionId: string;
  sessionKind?: PushSessionKind;
};

export interface DecryptedPushNotification {
  title: string;
  body: string;
  category: PushCategory;
  data: DecryptedPushRouting;
}

export async function decryptPushBlob(blob: string): Promise<DecryptedPushNotification | null> {
  try {
    const pushKey = await getPushKeyIfExists();
    if (!pushKey) return null;
    const identityPublicKey = await getPushIdentityPublicKey();
    if (!identityPublicKey) return null;
    const plaintext = openPushEnvelope(pushKey, identityPublicKey, blob);
    // For a Command Terminal the desktop puts the terminal's name in
    // `taskTitle` (protocol 0.20.0); a nameless one still reads as what it is.
    const isCommandTerminal = plaintext.sessionKind === 'command-terminal';
    const fallbackTitle = isCommandTerminal ? 'Command Terminal' : 'Agent session';
    const taskTitle = plaintext.taskTitle.length > 0 ? plaintext.taskTitle : fallbackTitle;
    return {
      title: titleForCategory(plaintext.category),
      body: plaintext.detail.length > 0 ? `${taskTitle} - ${plaintext.detail}` : taskTitle,
      category: plaintext.category,
      data: {
        taskId: plaintext.taskId,
        projectId: plaintext.projectId,
        sessionId: plaintext.sessionId,
        ...(isCommandTerminal ? { sessionKind: plaintext.sessionKind } : {}),
      },
    };
  } catch {
    // Deliberately swallowed without logging: the error message can echo
    // attacker-controlled bytes, and decrypted content must never leak.
    return null;
  }
}
