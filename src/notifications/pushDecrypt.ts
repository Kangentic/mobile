import { openPushEnvelope, type PushCategory } from '@kangentic/protocol';
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

export interface DecryptedPushNotification {
  title: string;
  body: string;
  category: PushCategory;
  data: {
    taskId: string;
    projectId: string;
    sessionId: string;
  };
}

export async function decryptPushBlob(blob: string): Promise<DecryptedPushNotification | null> {
  try {
    const pushKey = await getPushKeyIfExists();
    if (!pushKey) return null;
    const identityPublicKey = await getPushIdentityPublicKey();
    if (!identityPublicKey) return null;
    const plaintext = openPushEnvelope(pushKey, identityPublicKey, blob);
    const taskTitle = plaintext.taskTitle.length > 0 ? plaintext.taskTitle : 'Agent session';
    return {
      title: titleForCategory(plaintext.category),
      body: plaintext.detail.length > 0 ? `${taskTitle} - ${plaintext.detail}` : taskTitle,
      category: plaintext.category,
      data: {
        taskId: plaintext.taskId,
        projectId: plaintext.projectId,
        sessionId: plaintext.sessionId,
      },
    };
  } catch {
    // Deliberately swallowed without logging: the error message can echo
    // attacker-controlled bytes, and decrypted content must never leak.
    return null;
  }
}
