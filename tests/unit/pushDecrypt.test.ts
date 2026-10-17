/**
 * On-device push decryption: fixtures are sealed with the REAL protocol
 * sealPushEnvelope, and every failure mode (missing key, tampered blob,
 * wrong recipient AAD, stale sentAt) must return null so the caller shows
 * the generic placeholder - never ciphertext, never plaintext
 * (e2e-notification-privacy.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bytesToHex,
  generateX25519KeyPair,
  randomBytes,
  sealPushEnvelope,
  type PushEnvelopePlaintext,
} from '@kangentic/protocol';

const secureStoreState = vi.hoisted(() => ({ storedValues: new Map<string, string>() }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => secureStoreState.storedValues.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStoreState.storedValues.set(key, value);
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

type PushDecryptModule = typeof import('@/notifications/pushDecrypt');
type PushIdentityModule = typeof import('@/notifications/pushIdentity');

async function loadModules(): Promise<{ pushDecrypt: PushDecryptModule; pushIdentity: PushIdentityModule }> {
  const pushDecrypt = await import('@/notifications/pushDecrypt');
  const pushIdentity = await import('@/notifications/pushIdentity');
  return { pushDecrypt, pushIdentity };
}

function plaintextFixture(overrides: Partial<PushEnvelopePlaintext> = {}): PushEnvelopePlaintext {
  return {
    category: 'input-required',
    projectId: 'project-1',
    taskId: 'task-1',
    sessionId: 'sess-1',
    taskTitle: 'Fix the flaky test',
    detail: 'Bash: npm run test',
    sentAt: Date.now(),
    ...overrides,
  };
}

describe('decryptPushBlob', () => {
  beforeEach(() => {
    vi.resetModules();
    secureStoreState.storedValues.clear();
  });

  it('opens a real sealed envelope and maps category/title/body/data', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const blob = sealPushEnvelope(pushKey, identity.publicKey, plaintextFixture());
    const decrypted = await pushDecrypt.decryptPushBlob(blob);

    expect(decrypted).not.toBeNull();
    expect(decrypted?.title).toBe('Agent needs your input');
    expect(decrypted?.body).toBe('Fix the flaky test - Bash: npm run test');
    expect(decrypted?.category).toBe('input-required');
    expect(decrypted?.data).toStrictEqual({ category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' });
  });

  it('maps every category to its human title', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const expectedTitles = {
      'input-required': 'Agent needs your input',
      'turn-complete': 'Agent went idle',
      'session-failed': 'Session stopped',
      'plan-complete': 'Plan complete',
      'spawn-stalled': 'Still preparing',
      'workflow-complete': 'Workflow complete',
    } as const;
    for (const [category, expectedTitle] of Object.entries(expectedTitles)) {
      const blob = sealPushEnvelope(
        pushKey,
        identity.publicKey,
        plaintextFixture({ category: category as PushEnvelopePlaintext['category'], detail: '' }),
      );
      const decrypted = await pushDecrypt.decryptPushBlob(blob);
      expect(decrypted?.title).toBe(expectedTitle);
      expect(decrypted?.body).toBe('Fix the flaky test');
    }
  });

  it('falls back to the identity persisted in SecureStore when no active identity is set', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    secureStoreState.storedValues.set('device.identity.sk', bytesToHex(identity.secretKey));
    const { pushDecrypt } = await loadModules();

    const blob = sealPushEnvelope(pushKey, identity.publicKey, plaintextFixture());
    const decrypted = await pushDecrypt.decryptPushBlob(blob);
    expect(decrypted?.data.sessionId).toBe('sess-1');
  });

  it('returns null when no push key is stored', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const blob = sealPushEnvelope(pushKey, identity.publicKey, plaintextFixture());
    expect(await pushDecrypt.decryptPushBlob(blob)).toBeNull();
  });

  it('returns null on a tampered blob', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const blob = sealPushEnvelope(pushKey, identity.publicKey, plaintextFixture());
    const tamperIndex = blob.length - 2;
    const replacementChar = blob[tamperIndex] === 'A' ? 'B' : 'A';
    const tamperedBlob = blob.slice(0, tamperIndex) + replacementChar + blob.slice(tamperIndex + 1);
    expect(await pushDecrypt.decryptPushBlob(tamperedBlob)).toBeNull();
    expect(await pushDecrypt.decryptPushBlob('not-a-blob')).toBeNull();
  });

  it('returns null when sealed for a different recipient (AAD mismatch)', async () => {
    const pushKey = randomBytes(32);
    const thisPhone = generateX25519KeyPair();
    const someOtherPhone = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(thisPhone.publicKey);

    const blob = sealPushEnvelope(pushKey, someOtherPhone.publicKey, plaintextFixture());
    expect(await pushDecrypt.decryptPushBlob(blob)).toBeNull();
  });

  it('returns null when sealed with a different push key', async () => {
    const registeredKey = randomBytes(32);
    const wrongKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(registeredKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const blob = sealPushEnvelope(wrongKey, identity.publicKey, plaintextFixture());
    expect(await pushDecrypt.decryptPushBlob(blob)).toBeNull();
  });

  it('returns null on a stale envelope (sentAt older than the freshness window)', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const staleSentAt = Date.now() - 25 * 60 * 60 * 1000;
    const blob = sealPushEnvelope(pushKey, identity.publicKey, plaintextFixture({ sentAt: staleSentAt }));
    expect(await pushDecrypt.decryptPushBlob(blob)).toBeNull();
  });

  /**
   * A Command Terminal's envelope (protocol 0.20.0) names a made-up task id, so
   * the tap must be able to tell it from a task's agent by `sessionKind` alone.
   * The key rides into notifee's string-valued `data` and is what tapRouter
   * branches on; losing it opens the made-up id as a blank task screen.
   *
   * Mutation that reddens this: drop the `sessionKind` spread from `data` in
   * decryptPushBlob (data comes back without the key).
   */
  it('carries sessionKind through for a Command Terminal envelope', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const blob = sealPushEnvelope(
      pushKey,
      identity.publicKey,
      plaintextFixture({
        taskId: 'made-up-terminal-task',
        sessionId: 'terminal-sess-1',
        taskTitle: 'Fix The Flaky Test',
        sessionKind: 'command-terminal',
      }),
    );
    const decrypted = await pushDecrypt.decryptPushBlob(blob);

    expect(decrypted?.data).toStrictEqual({
      category: 'input-required',
      taskId: 'made-up-terminal-task',
      projectId: 'project-1',
      sessionId: 'terminal-sess-1',
      sessionKind: 'command-terminal',
    });
    // The terminal's own name leads the body, as a task's title would.
    expect(decrypted?.body).toBe('Fix The Flaky Test - Bash: npm run test');
  });

  /**
   * The other half: a task's envelope must come back with NO `sessionKind` key
   * at all, not `sessionKind: undefined`. notifee rejects non-string `data`
   * values, and a present-but-undefined key is exactly that. toStrictEqual is
   * what tells an absent key from an undefined one; toEqual cannot.
   *
   * Mutation that reddens this: set `sessionKind: plaintext.sessionKind`
   * unconditionally in `data` (a stray `sessionKind: undefined` key).
   */
  it('omits the sessionKind key entirely for a task envelope', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const blob = sealPushEnvelope(pushKey, identity.publicKey, plaintextFixture());
    const decrypted = await pushDecrypt.decryptPushBlob(blob);

    expect(decrypted).not.toBeNull();
    expect(decrypted?.data).toStrictEqual({ category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' });
    expect(Object.keys(decrypted?.data ?? {})).not.toContain('sessionKind');
  });

  /**
   * A workflow-complete envelope (protocol 0.21.0): every task of a workflow
   * reached Done. `taskTitle` is the workflow's name, `projectId` its HOME
   * project, and the task and session ids are EMPTY strings. It must decrypt
   * like any other (empty ids are not a malformed envelope), read as the
   * desktop's own title, and carry its category in `data`, which is the only
   * thing the Android press reads to route it to the Board rather than drop it.
   *
   * Mutation that reddens this: drop `category` from `data` in decryptPushBlob
   * (the press can no longer tell it from a task alert with an empty id).
   */
  it('opens a workflow-complete envelope with empty ids, titled, with its category in data', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const blob = sealPushEnvelope(
      pushKey,
      identity.publicKey,
      plaintextFixture({
        category: 'workflow-complete',
        projectId: 'home-project',
        taskId: '',
        sessionId: '',
        taskTitle: 'Checkout hardening',
        detail: 'All 6 tasks are in Done.',
      }),
    );
    const decrypted = await pushDecrypt.decryptPushBlob(blob);

    expect(decrypted?.title).toBe('Workflow complete');
    expect(decrypted?.body).toBe('Checkout hardening - All 6 tasks are in Done.');
    expect(decrypted?.category).toBe('workflow-complete');
    expect(decrypted?.data).toStrictEqual({ category: 'workflow-complete', taskId: '', projectId: 'home-project', sessionId: '' });
  });

  /**
   * An empty `taskTitle` falls back to 'Agent session' for a terminal exactly
   * as for a task. The iOS extension composes the body without reading
   * `sessionKind` (targets/nse/CategoryCopy.swift), so a terminal-only fallback
   * here would make the same push read differently on the two platforms. The
   * desktop names every terminal in `taskTitle`, so this is the edge case only.
   *
   * Mutation that reddens this: give a terminal its own fallback (the
   * notification reading "Command Terminal" on Android alone).
   */
  it.each([
    { label: 'a Command Terminal', sessionKind: 'command-terminal' as const, expectedBody: 'Agent session' },
    { label: 'a task', sessionKind: undefined, expectedBody: 'Agent session' },
  ])('falls back to the one shared nameless title for $label with an empty taskTitle', async ({ sessionKind, expectedBody }) => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const blob = sealPushEnvelope(
      pushKey,
      identity.publicKey,
      plaintextFixture({ taskTitle: '', detail: '', ...(sessionKind !== undefined ? { sessionKind } : {}) }),
    );
    const decrypted = await pushDecrypt.decryptPushBlob(blob);

    expect(decrypted?.body).toBe(expectedBody);
  });

  it('puts the fallback title ahead of the detail when the terminal is nameless but has detail', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const blob = sealPushEnvelope(
      pushKey,
      identity.publicKey,
      plaintextFixture({ taskTitle: '', detail: 'Bash: npm run test', sessionKind: 'command-terminal' }),
    );
    const decrypted = await pushDecrypt.decryptPushBlob(blob);

    expect(decrypted?.body).toBe('Agent session - Bash: npm run test');
  });

  it('exports the generic placeholder copy the callers degrade to', async () => {
    const { pushDecrypt } = await loadModules();
    expect(pushDecrypt.PUSH_PLACEHOLDER_TITLE).toBe('Kangentic');
    expect(pushDecrypt.PUSH_PLACEHOLDER_BODY).toBe('Agent needs attention');
  });
});
