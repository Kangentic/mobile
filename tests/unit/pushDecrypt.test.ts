/**
 * On-device push decryption: fixtures are sealed with the REAL protocol
 * sealPushEnvelope, and every failure mode (missing key, tampered blob,
 * wrong recipient AAD, stale sentAt) must return null so the caller shows
 * the generic placeholder - never ciphertext, never plaintext
 * (e2e-notification-privacy.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bytesToHex,
  generateX25519KeyPair,
  randomBytes,
  sealPushClear,
  sealPushEnvelope,
  type PushEnvelopePlaintext,
} from '@kangentic/protocol';

/**
 * `rejectingReadKeys` makes a read of that key throw, as a Keychain item that is
 * unreadable (a locked device) does. A set keyed on the item rather than a
 * mockImplementationOnce on purpose: decryptPushBlob reads `push.decrypt.key`
 * before it ever asks for the identity, so a once-stub would reject the wrong read.
 */
const secureStoreState = vi.hoisted(() => ({
  storedValues: new Map<string, string>(),
  rejectingReadKeys: new Set<string>(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    if (secureStoreState.rejectingReadKeys.has(key)) throw new Error('keychain item unreadable');
    return secureStoreState.storedValues.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStoreState.storedValues.set(key, value);
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
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

    const plaintext = plaintextFixture();
    const blob = sealPushEnvelope(pushKey, identity.publicKey, plaintext);
    const decrypted = await pushDecrypt.decryptPushBlob(blob);

    expect(decrypted).not.toBeNull();
    expect(decrypted?.title).toBe('Agent needs your input');
    expect(decrypted?.body).toBe('Fix the flaky test - Bash: npm run test');
    expect(decrypted?.category).toBe('input-required');
    expect(decrypted?.data).toStrictEqual({
      category: 'input-required',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: 'sess-1',
      sentAt: String(plaintext.sentAt),
    });
    expect(decrypted?.sentAt).toBe(plaintext.sentAt);
    expect(decrypted?.clears).toEqual([]);
    expect(decrypted?.authored).toBe(false);
  });

  /**
   * Protocol 0.26.0: the wait's kind titles an input-required push, as the
   * desktop's own notification does. The body stays the task title and detail.
   */
  it.each([
    ['question', 'Agent has a question'],
    ['approval', 'Agent needs your approval'],
  ] as const)('titles an input-required %s by its kind over the same body', async (waitKind, expectedTitle) => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const decrypted = await pushDecrypt.decryptPushBlob(sealPushEnvelope(pushKey, identity.publicKey, plaintextFixture({ waitKind })));

    expect(decrypted?.title).toBe(expectedTitle);
    expect(decrypted?.body).toBe('Fix the flaky test - Bash: npm run test');
    expect(decrypted?.authored).toBe(false);
  });

  it('keeps the category title for a wait kind this build does not know, or one on another category', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const newerKind = { ...plaintextFixture(), waitKind: 'plan' } as unknown as PushEnvelopePlaintext;
    expect((await pushDecrypt.decryptPushBlob(sealPushEnvelope(pushKey, identity.publicKey, newerKind)))?.title).toBe('Agent needs your input');
    const otherCategory = plaintextFixture({ category: 'turn-complete', waitKind: 'question' });
    expect((await pushDecrypt.decryptPushBlob(sealPushEnvelope(pushKey, identity.publicKey, otherCategory)))?.title).toBe('Agent went idle');
  });

  /**
   * A Notify me automation row (protocol 0.26.0): its own Title over its own
   * Body, an empty session so a tap opens the task, and the authored flag that
   * keeps the reconciler and the foreground gates off it.
   */
  it('shows a Notify me push as its own Title over its own Body, and marks it authored', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const plaintext = plaintextFixture({ sessionId: '', detail: 'Blocked', title: 'Cap retries in the sync client', body: 'Blocked' });
    const decrypted = await pushDecrypt.decryptPushBlob(sealPushEnvelope(pushKey, identity.publicKey, plaintext));

    expect(decrypted?.title).toBe('Cap retries in the sync client');
    expect(decrypted?.body).toBe('Blocked');
    expect(decrypted?.authored).toBe(true);
    expect(decrypted?.data).toStrictEqual({
      category: 'input-required',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: '',
      authored: 'true',
      sentAt: String(plaintext.sentAt),
    });
  });

  it('reads a Body with no Title as an ordinary input-required push, not an authored one', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const malformedTitle = { ...plaintextFixture({ sessionId: '', detail: 'Blocked', body: 'Blocked' }), title: 7 } as unknown as PushEnvelopePlaintext;
    const decrypted = await pushDecrypt.decryptPushBlob(sealPushEnvelope(pushKey, identity.publicKey, malformedTitle));

    expect(decrypted?.title).toBe('Agent needs your input');
    expect(decrypted?.body).toBe('Fix the flaky test - Blocked');
    expect(decrypted?.authored).toBe(false);
    expect(decrypted?.data).not.toHaveProperty('authored');
  });

  /**
   * The other half of "set together" (protocol 0.26.0): a Title with no usable
   * Body is not a Notify me push either. The protocol's parser keeps each field
   * only when it is a string, independently, so an absent Body and a malformed
   * one both leave a lone Title, and showing it would pair a written Title with
   * the composed body of a different alert. The whole alert reads as an ordinary
   * input-required instead.
   *
   * Mutation that reddens both rows (the existing Body-with-no-Title test stays
   * green under it): bind only the Title in `notifyMeText`, i.e. drop
   * `&& plaintext.body !== undefined` from its condition. Seen red on `title`
   * ('Cap retries' for 'Agent needs your input'), `authored` and the `authored` data key.
   */
  it.each([
    ['no Body at all', plaintextFixture({ sessionId: '', detail: 'Blocked', title: 'Cap retries' })],
    [
      'a Body that is not a string',
      { ...plaintextFixture({ sessionId: '', detail: 'Blocked', title: 'Cap retries' }), body: 7 } as unknown as PushEnvelopePlaintext,
    ],
  ])('reads a Title with %s as an ordinary input-required push, not an authored one', async (_label, plaintext) => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const decrypted = await pushDecrypt.decryptPushBlob(sealPushEnvelope(pushKey, identity.publicKey, plaintext));

    expect(decrypted?.title).toBe('Agent needs your input');
    expect(decrypted?.body).toBe('Fix the flaky test - Blocked');
    expect(decrypted?.authored).toBe(false);
    expect(decrypted?.data).toStrictEqual({
      category: 'input-required',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: '',
      sentAt: String(plaintext.sentAt),
    });
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

    const plaintext = plaintextFixture({
      taskId: 'made-up-terminal-task',
      sessionId: 'terminal-sess-1',
      taskTitle: 'Fix The Flaky Test',
      sessionKind: 'command-terminal',
    });
    const blob = sealPushEnvelope(pushKey, identity.publicKey, plaintext);
    const decrypted = await pushDecrypt.decryptPushBlob(blob);

    expect(decrypted?.data).toStrictEqual({
      category: 'input-required',
      taskId: 'made-up-terminal-task',
      projectId: 'project-1',
      sessionId: 'terminal-sess-1',
      sessionKind: 'command-terminal',
      sentAt: String(plaintext.sentAt),
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

    const plaintext = plaintextFixture();
    const blob = sealPushEnvelope(pushKey, identity.publicKey, plaintext);
    const decrypted = await pushDecrypt.decryptPushBlob(blob);

    expect(decrypted).not.toBeNull();
    expect(decrypted?.data).toStrictEqual({
      category: 'input-required',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: 'sess-1',
      sentAt: String(plaintext.sentAt),
    });
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

    const plaintext = plaintextFixture({
      category: 'workflow-complete',
      projectId: 'home-project',
      taskId: '',
      sessionId: '',
      taskTitle: 'Checkout hardening',
      detail: 'All 6 tasks are in Done.',
    });
    const blob = sealPushEnvelope(pushKey, identity.publicKey, plaintext);
    const decrypted = await pushDecrypt.decryptPushBlob(blob);

    expect(decrypted?.title).toBe('Workflow complete');
    expect(decrypted?.body).toBe('Checkout hardening - All 6 tasks are in Done.');
    expect(decrypted?.category).toBe('workflow-complete');
    expect(decrypted?.data).toStrictEqual({
      category: 'workflow-complete',
      taskId: '',
      projectId: 'home-project',
      sessionId: '',
      sentAt: String(plaintext.sentAt),
    });
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

  /**
   * Piggybacked clears (protocol 0.23.0) come back parsed by the protocol's own
   * tolerant parser: a malformed entry is dropped on its own, and never costs
   * the notification it rides on.
   */
  it('returns the clears a notification carries, dropping a malformed entry on its own', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const goodEntry = { category: 'turn-complete' as const, projectId: 'project-1', taskId: 'task-1', sessionId: 'sess-0', notifiedAt: Date.now() - 5_000 };
    const blob = sealPushEnvelope(pushKey, identity.publicKey, {
      ...plaintextFixture(),
      clears: [goodEntry, { ...goodEntry, category: 'not-a-category' } as never],
    });
    const decrypted = await pushDecrypt.decryptPushBlob(blob);

    expect(decrypted?.title).toBe('Agent needs your input');
    expect(decrypted?.clears).toEqual([goodEntry]);
  });
});

describe('decryptPushClear', () => {
  beforeEach(() => {
    vi.resetModules();
    secureStoreState.storedValues.clear();
  });

  const entry = { category: 'input-required' as const, projectId: 'project-1', taskId: 'task-1', sessionId: 'sess-1', notifiedAt: Date.now() - 5_000 };

  it('opens a real sealed clear to its entries', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const blob = sealPushClear(pushKey, identity.publicKey, { clears: [entry], sentAt: Date.now() });
    expect(await pushDecrypt.decryptPushClear(blob)).toEqual([entry]);
  });

  it.each([
    ['sealed with another push key', (pushKey: Uint8Array, recipient: Uint8Array) => sealPushClear(randomBytes(32), recipient, { clears: [entry], sentAt: Date.now() })],
    ['sealed for another recipient', (pushKey: Uint8Array) => sealPushClear(pushKey, generateX25519KeyPair().publicKey, { clears: [entry], sentAt: Date.now() })],
    ['stale', (pushKey: Uint8Array, recipient: Uint8Array) => sealPushClear(pushKey, recipient, { clears: [entry], sentAt: Date.now() - 25 * 60 * 60 * 1000 })],
    ['missing its clears array', (pushKey: Uint8Array, recipient: Uint8Array) => sealPushClear(pushKey, recipient, { clears: 'none' as never, sentAt: Date.now() })],
    ['not a blob at all', () => 'not-a-blob'],
  ])('returns null for a clear %s', async (_label, buildBlob) => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    expect(await pushDecrypt.decryptPushClear(buildBlob(pushKey, identity.publicKey))).toBeNull();
  });

  it('returns null when no push key is stored', async () => {
    const identity = generateX25519KeyPair();
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    expect(await pushDecrypt.decryptPushClear(sealPushClear(randomBytes(32), identity.publicKey, { clears: [entry], sentAt: Date.now() }))).toBeNull();
  });
});

/**
 * A clear is recognised by its KEY, whatever the value, in every shape a push
 * reaches JS in: top level (an FCM data message), the `dataString` copy and an
 * FCM `body` string (Android), and a `body` that is still a dictionary (the iOS
 * background task, which gets the raw `userInfo`).
 */
describe('pushPayloadCarriesClear and extractClearFromTaskData', () => {
  it.each([
    ['at top level', { clear: 'sealed' }, true, 'sealed'],
    ['at top level with a non-string value', { clear: 42 }, true, null],
    ['inside dataString', { dataString: JSON.stringify({ clear: 'sealed' }) }, true, 'sealed'],
    ['inside a body string', { body: JSON.stringify({ clear: 'sealed' }) }, true, 'sealed'],
    ['inside a body dictionary', { body: { clear: 'sealed' } }, true, 'sealed'],
    ['nowhere: a notification envelope', { blob: 'sealed' }, false, null],
    ['nowhere: malformed dataString', { dataString: 'not json' }, false, null],
    ['nowhere: not a record', 'a string', false, null],
    ['nowhere: null', null, false, null],
  ])('%s', async (_label, payload, expectedCarries, expectedBlob) => {
    const { pushDecrypt } = await loadModules();
    expect(pushDecrypt.pushPayloadCarriesClear(payload)).toBe(expectedCarries);
    expect(pushDecrypt.extractClearFromTaskData(payload)).toBe(expectedBlob);
  });
});

/**
 * The AAD a background launch decrypts with. On iOS that launch is usually
 * with the phone LOCKED, where the identity secret (`WHEN_UNLOCKED`) is
 * unreadable, so the shared `push.identity.pk` copy (`AFTER_FIRST_UNLOCK`) is
 * read first. Off iOS (no shared group) it is never read at all.
 *
 * Mutation that reddens the first case: drop the shared-copy read from
 * getPushIdentityPublicKey. Seen red (null: the persisted secret is another
 * identity's, so the AAD no longer matches).
 *
 * Mutation that reddens the throwing-read case: remove the try/catch around
 * that shared-copy read. Seen red (null: the rejection escapes to
 * decryptPushBlob's own catch, so the push degrades to the placeholder instead
 * of opening).
 */
describe('getPushIdentityPublicKey with no active connection', () => {
  beforeEach(() => {
    vi.resetModules();
    secureStoreState.storedValues.clear();
    secureStoreState.rejectingReadKeys.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    secureStoreState.rejectingReadKeys.clear();
  });

  it('reads the shared copy the extension uses before the identity secret, where there is a shared group', async () => {
    vi.stubEnv('EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP', 'TEAMID.com.kangentic.mobile.shared');
    const pushKey = randomBytes(32);
    const registered = generateX25519KeyPair();
    const unrelatedSecret = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    secureStoreState.storedValues.set('push.identity.pk', bytesToHex(registered.publicKey));
    secureStoreState.storedValues.set('device.identity.sk', bytesToHex(unrelatedSecret.secretKey));
    const { pushDecrypt } = await loadModules();

    const blob = sealPushEnvelope(pushKey, registered.publicKey, plaintextFixture());
    expect((await pushDecrypt.decryptPushBlob(blob))?.data.sessionId).toBe('sess-1');
  });

  it('falls back to the device identity when the shared copy cannot be read', async () => {
    vi.stubEnv('EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP', 'TEAMID.com.kangentic.mobile.shared');
    const pushKey = randomBytes(32);
    const registered = generateX25519KeyPair();
    const deviceIdentity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    // A perfectly good shared copy for a DIFFERENT identity, so only the throw (not an
    // absent item) explains the envelope sealed to the device identity opening.
    secureStoreState.storedValues.set('push.identity.pk', bytesToHex(registered.publicKey));
    secureStoreState.storedValues.set('device.identity.sk', bytesToHex(deviceIdentity.secretKey));
    secureStoreState.rejectingReadKeys.add('push.identity.pk');
    const secureStoreModule = await import('expo-secure-store');
    const { pushDecrypt } = await loadModules();

    const decrypted = await pushDecrypt.decryptPushBlob(sealPushEnvelope(pushKey, deviceIdentity.publicKey, plaintextFixture()));

    // The shared read really was attempted and threw: a skipped read would pass for the wrong reason.
    expect(vi.mocked(secureStoreModule.getItemAsync).mock.calls.map(([key]) => key)).toContain('push.identity.pk');
    expect(decrypted).not.toBeNull();
    expect(decrypted?.data.sessionId).toBe('sess-1');
  });

  it('never reads that copy without a shared group (every Android build)', async () => {
    const pushKey = randomBytes(32);
    const registered = generateX25519KeyPair();
    const deviceIdentity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    secureStoreState.storedValues.set('push.identity.pk', bytesToHex(registered.publicKey));
    secureStoreState.storedValues.set('device.identity.sk', bytesToHex(deviceIdentity.secretKey));
    const { pushDecrypt } = await loadModules();

    expect(await pushDecrypt.decryptPushBlob(sealPushEnvelope(pushKey, registered.publicKey, plaintextFixture()))).toBeNull();
    expect((await pushDecrypt.decryptPushBlob(sealPushEnvelope(pushKey, deviceIdentity.publicKey, plaintextFixture())))?.data.sessionId).toBe('sess-1');
  });
});
