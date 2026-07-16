import { openPushEnvelope, type PushCategory } from '@kangentic/protocol';
import { getPushKeyIfExists } from './pushKeys';
import { getPushIdentityPublicKey } from './pushIdentity';

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

function titleForCategory(category: PushCategory): string {
  switch (category) {
    case 'permission-needed':
      return 'Agent needs your approval';
    case 'agent-question':
      return 'Agent has a question';
    case 'turn-complete':
      return 'Turn complete';
    case 'session-failed':
      return 'Session stopped';
  }
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
