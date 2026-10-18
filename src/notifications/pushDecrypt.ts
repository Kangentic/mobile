import {
  openPushClear,
  openPushEnvelope,
  PUSH_CLEAR_DATA_KEY,
  type PushCategory,
  type PushClearEntry,
  type PushSessionKind,
} from '@kangentic/protocol';
import { getPushKeyIfExists } from './pushKeys';
import { getPushIdentityPublicKey } from './pushIdentity';
import { titleForCategory } from './categoryCopy';
import { SENT_AT_DATA_KEY } from './notificationRouting';

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
 * Finds the `clear` key (PUSH_CLEAR_DATA_KEY, protocol 0.23.0) in the same three
 * places extractBlobFromTaskData looks for `blob`, plus a `body` that is already
 * a record: that is the shape the iOS background task receives, since
 * expo-notifications hands it the raw `userInfo` with Expo's `body` dictionary
 * still nested (BackgroundEventTransformer.swift) alongside the `dataString`
 * copy of it.
 */
function findClearField(data: unknown): { found: boolean; value: unknown } {
  if (!isUnknownRecord(data)) return { found: false, value: undefined };
  if (PUSH_CLEAR_DATA_KEY in data) return { found: true, value: data[PUSH_CLEAR_DATA_KEY] };
  for (const nestedKey of ['dataString', 'body']) {
    const nested = data[nestedKey];
    let nestedRecord: unknown = nested;
    if (typeof nested === 'string') {
      try {
        nestedRecord = JSON.parse(nested);
      } catch {
        nestedRecord = null;
      }
    }
    if (isUnknownRecord(nestedRecord) && PUSH_CLEAR_DATA_KEY in nestedRecord) {
      return { found: true, value: nestedRecord[PUSH_CLEAR_DATA_KEY] };
    }
  }
  return { found: false, value: undefined };
}

/**
 * Whether a push is a sealed clear, decided by the KEY's presence alone, before
 * anything is decrypted and whatever its value. A clear must never fall through
 * to the display path, where a payload with no `blob` posts the placeholder: a
 * clear with a malformed value is still a clear, and still displays nothing.
 */
export function pushPayloadCarriesClear(data: unknown): boolean {
  return findClearField(data).found;
}

/** The sealed clear's base64url blob, or null when there is none or it is not a string. */
export function extractClearFromTaskData(data: unknown): string | null {
  const { value } = findClearField(data);
  return typeof value === 'string' ? value : null;
}

/**
 * Opens a sealed clear (protocol 0.23.0) and returns what it names, or null on
 * every failure: no key, no identity, wrong key or recipient, tampered or
 * malformed, stale or future `sentAt`. Swallowed without logging, as below. A
 * caller that gets null does NOTHING: a clear never renders, so its failure
 * mode is silence rather than the placeholder (e2e-notification-privacy.md).
 */
export async function decryptPushClear(blob: string): Promise<PushClearEntry[] | null> {
  try {
    const pushKey = await getPushKeyIfExists();
    if (!pushKey) return null;
    const identityPublicKey = await getPushIdentityPublicKey();
    if (!identityPublicKey) return null;
    return openPushClear(pushKey, identityPublicKey, blob).clears;
  } catch {
    return null;
  }
}

/**
 * The routing identity a decrypted notification carries into notifee's
 * `data` (string values only, which notifee requires). `sessionKind` is set
 * only for a Command Terminal (protocol 0.20.0), whose `taskId` names no board
 * task: the tap then opens that terminal by `sessionId`, and must never open
 * the made-up task id as a task. `category` rides along so the Android press,
 * which reads only this `data`, can route a workflow-complete (protocol
 * 0.21.0), whose task and session ids are EMPTY, to its home project's Board.
 * `sentAt` is the envelope's own desktop-clock seal time, kept so a later
 * sealed clear can bound what it removes (SENT_AT_DATA_KEY).
 * A type alias rather than an interface, so it assigns to notifee's
 * string-keyed `data` as it is.
 */
export type DecryptedPushRouting = {
  category: PushCategory;
  taskId: string;
  projectId: string;
  sessionId: string;
  sessionKind?: PushSessionKind;
  [SENT_AT_DATA_KEY]: string;
};

export interface DecryptedPushNotification {
  title: string;
  body: string;
  category: PushCategory;
  data: DecryptedPushRouting;
  /** The envelope's seal time on the desktop's clock, epoch ms. */
  sentAt: number;
  /** Older alerts this push resolves (protocol 0.23.0); applied BEFORE this one is presented. Empty when none. */
  clears: PushClearEntry[];
}

export async function decryptPushBlob(blob: string): Promise<DecryptedPushNotification | null> {
  try {
    const pushKey = await getPushKeyIfExists();
    if (!pushKey) return null;
    const identityPublicKey = await getPushIdentityPublicKey();
    if (!identityPublicKey) return null;
    const plaintext = openPushEnvelope(pushKey, identityPublicKey, blob);
    // For a Command Terminal the desktop puts the terminal's name in
    // `taskTitle` (protocol 0.20.0). The empty-title fallback stays one string
    // for every kind: the iOS extension composes the same body without reading
    // `sessionKind` (targets/nse/CategoryCopy.swift), and
    // nseConstantsParity.test.ts holds the two platforms to one expression.
    const isCommandTerminal = plaintext.sessionKind === 'command-terminal';
    const taskTitle = plaintext.taskTitle.length > 0 ? plaintext.taskTitle : 'Agent session';
    return {
      title: titleForCategory(plaintext.category),
      body: plaintext.detail.length > 0 ? `${taskTitle} - ${plaintext.detail}` : taskTitle,
      category: plaintext.category,
      data: {
        category: plaintext.category,
        taskId: plaintext.taskId,
        projectId: plaintext.projectId,
        sessionId: plaintext.sessionId,
        ...(isCommandTerminal ? { sessionKind: plaintext.sessionKind } : {}),
        [SENT_AT_DATA_KEY]: String(plaintext.sentAt),
      },
      sentAt: plaintext.sentAt,
      clears: plaintext.clears ?? [],
    };
  } catch {
    // Deliberately swallowed without logging: the error message can echo
    // attacker-controlled bytes, and decrypted content must never leak.
    return null;
  }
}
